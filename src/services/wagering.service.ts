import { randomUUID } from 'node:crypto';
import {
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { DataSource, QueryRunner } from 'typeorm';
import { DomainHttpError } from '../app/errors';
import { MetricsService } from './metrics.service';
import { ProviderIdentityPort } from '../auth/provider-identity.port';
import { Money } from '../domain/money';
import {
  canonicalPayloadHash,
  validateWagerInput,
  WagerInput,
} from '../domain/wager';

interface ProcessOptions {
  messageId?: string;
  consumerName?: string;
}

export interface ProcessResult {
  transactionId: string;
  status: string;
  balance?: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}

interface WalletRow {
  id: string;
  player_id: string;
  currency: string;
  balance: string;
  version: string;
}

interface TransactionRow {
  id: string;
  provider_id: string;
  external_transaction_id: string;
  idempotency_key: string;
  payload_hash: string;
  wallet_id: string;
  player_id: string;
  round_id: string;
  game_id: string;
  kind: string;
  amount: string;
  currency: string;
  reference_external_transaction_id: string | null;
  status: string;
  failure_code: string | null;
  result_balance: string | null;
}

@Injectable()
export class WageringService implements OnModuleInit, OnModuleDestroy {
  private stopping = false;
  private retryLoop?: Promise<void>;

  /** Recebe persistência, métricas e validação da identidade do provedor. */
  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: MetricsService,
    private readonly providerIdentity: ProviderIdentityPort,
  ) {}

  /** Inicia o worker que reprocessa transações aguardando referência. */
  onModuleInit(): void {
    this.retryLoop = this.retryPendingReferences();
  }

  /** Solicita a parada do worker de referências antes de encerrar o serviço. */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.retryLoop;
  }

  /**
   * Processa uma aposta de forma idempotente e transacional, incluindo
   * bloqueio da carteira, ledger, Inbox e eventos da Outbox.
   */
  async process(
    input: WagerInput,
    idempotencyKey: string,
    options: ProcessOptions = {},
  ): Promise<ProcessResult> {
    let money: Money;
    try {
      money = validateWagerInput(input);
    } catch (error) {
      const code = error instanceof Error ? error.message : 'INVALID_REQUEST';
      throw new DomainHttpError(code, HttpStatus.BAD_REQUEST);
    }

    if (!idempotencyKey?.trim()) {
      throw new DomainHttpError('IDEMPOTENCY_KEY_REQUIRED', HttpStatus.BAD_REQUEST);
    }
    await this.providerIdentity.assertProvider(input.providerId);

    const payloadHash = canonicalPayloadHash(input);
    const runner = this.dataSource.createQueryRunner();
    const startedAt = Date.now();
    await runner.connect();
    await runner.startTransaction();

    try {
      if (options.messageId && options.consumerName) {
        const inbox = await runner.query(
          `INSERT INTO inbox_messages (consumer_name, message_id, payload_hash)
           VALUES ($1, $2, $3)
           ON CONFLICT (consumer_name, message_id) DO NOTHING
           RETURNING message_id`,
          [options.consumerName, options.messageId, payloadHash],
        );
        if (inbox.length === 0) {
          const existingInbox = await runner.query(
            `SELECT payload_hash FROM inbox_messages
             WHERE consumer_name = $1 AND message_id = $2`,
            [options.consumerName, options.messageId],
          ) as Array<{ payload_hash: string }>;
          if (existingInbox[0]?.payload_hash.trim() !== payloadHash) {
            throw new DomainHttpError('INBOX_MESSAGE_CONFLICT', HttpStatus.CONFLICT);
          }
          await runner.commitTransaction();
          const prior = await this.findByIdempotencyKey(idempotencyKey);
          if (prior) {
            const result = this.replay(prior, payloadHash);
            this.logResult(input, idempotencyKey, options, result);
            return result;
          }
          return {
            transactionId: options.messageId,
            status: 'PROCESSED',
            idempotentReplay: true,
          };
        }
      }

      let existingPending = await this.findByIdempotencyKey(idempotencyKey, runner);
      if (existingPending && existingPending.payload_hash.trim() !== payloadHash) {
        throw new DomainHttpError(
          'IDEMPOTENCY_KEY_PAYLOAD_CONFLICT',
          HttpStatus.CONFLICT,
        );
      }
      if (existingPending && existingPending.status !== 'PENDING_REFERENCE') {
        const result = this.replay(existingPending, payloadHash);
        this.logResult(input, idempotencyKey, options, result);
        if (options.messageId && options.consumerName) {
          await runner.query(
            `UPDATE inbox_messages SET processed_at = now()
             WHERE consumer_name = $1 AND message_id = $2`,
            [options.consumerName, options.messageId],
          );
        }
        await runner.commitTransaction();
        return result;
      }

      const wallets = await runner.query(
        `SELECT id, player_id, currency, balance::text, version::text
         FROM wallets WHERE id = $1 FOR UPDATE`,
        [input.walletId],
      ) as WalletRow[];
      const wallet = wallets[0];
      if (!wallet) {
        throw new DomainHttpError('WALLET_NOT_FOUND', HttpStatus.NOT_FOUND);
      }
      if (wallet.player_id !== input.playerId) {
        throw new DomainHttpError('PLAYER_WALLET_MISMATCH', HttpStatus.CONFLICT);
      }
      if (wallet.currency.trim() !== money.currency) {
        throw new DomainHttpError('CURRENCY_MISMATCH', HttpStatus.CONFLICT);
      }

      existingPending = await this.findByIdempotencyKey(idempotencyKey, runner);
      if (existingPending && existingPending.payload_hash.trim() !== payloadHash) {
        throw new DomainHttpError(
          'IDEMPOTENCY_KEY_PAYLOAD_CONFLICT',
          HttpStatus.CONFLICT,
        );
      }
      if (existingPending && existingPending.status !== 'PENDING_REFERENCE') {
        const result = this.replay(existingPending, payloadHash);
        this.logResult(input, idempotencyKey, options, result);
        await this.markInboxProcessed(runner, options);
        await runner.commitTransaction();
        return result;
      }

      if (existingPending?.status === 'PENDING_REFERENCE') {
        const dueRows = await runner.query(
          `SELECT next_attempt_at <= now() AS due
           FROM wager_transactions WHERE id = $1 FOR UPDATE`,
          [existingPending.id],
        ) as Array<{ due: boolean }>;
        if (!dueRows[0]?.due) {
          const result = this.replay(existingPending, payloadHash);
          this.logResult(input, idempotencyKey, options, result);
          await this.markInboxProcessed(runner, options);
          await runner.commitTransaction();
          return result;
        }
      }

      const transactionId = existingPending?.id ?? randomUUID();
      if (existingPending) {
        if (existingPending.payload_hash.trim() !== payloadHash) {
          throw new DomainHttpError(
            'IDEMPOTENCY_KEY_PAYLOAD_CONFLICT',
            HttpStatus.CONFLICT,
          );
        }
        await runner.query(
          `UPDATE wager_transactions SET status = 'PENDING' WHERE id = $1`,
          [transactionId],
        );
      } else {
        await runner.query(
          `INSERT INTO wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency,
             reference_external_transaction_id, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING')`,
          [
            transactionId, input.providerId, input.externalTransactionId, idempotencyKey,
            payloadHash, input.walletId, input.playerId, input.roundId, input.gameId,
            input.kind, money.toString(), money.currency,
            input.referenceExternalTransactionId ?? null,
          ],
        );
      }

      const currentBalance = Money.from({
        amount: wallet.balance,
        currency: wallet.currency.trim(),
      });
      let reference: TransactionRow | undefined;
      if (input.referenceExternalTransactionId) {
        const references = await runner.query(
          `SELECT * FROM wager_transactions
           WHERE provider_id = $1 AND external_transaction_id = $2
           FOR UPDATE`,
          [input.providerId, input.referenceExternalTransactionId],
        ) as TransactionRow[];
        reference = references[0];
        if (!reference) {
          const updated = await runner.query(
            `UPDATE wager_transactions
             SET attempts = attempts + 1, result_balance = $2,
                 status = CASE WHEN attempts + 1 >= 8 THEN 'REJECTED'
                               ELSE 'PENDING_REFERENCE' END,
                 failure_code = CASE WHEN attempts + 1 >= 8
                                     THEN 'REFERENCE_NOT_FOUND' END,
                 processed_at = CASE WHEN attempts + 1 >= 8 THEN now() END,
                 next_attempt_at = CASE WHEN attempts + 1 >= 8 THEN NULL
                   ELSE now() + (LEAST(300, 5 * power(2, attempts)) * interval '1 second')
                   END
             WHERE id = $1
             RETURNING attempts, status`,
            [transactionId, currentBalance.toString()],
          ) as Array<{ attempts: number; status: string }>;
          const expired = updated[0]?.status === 'REJECTED';
          if (!existingPending || expired) {
            await this.enqueueEvent(
              runner,
              input.walletId,
              expired ? 'WagerTransactionRejected' : 'WagerTransactionPendingReference',
              {
                transactionId,
                providerId: input.providerId,
                externalTransactionId: input.externalTransactionId,
                referenceExternalTransactionId: input.referenceExternalTransactionId,
                ...(expired ? { failureCode: 'REFERENCE_NOT_FOUND' } : {}),
              },
            );
          }
          await this.markInboxProcessed(runner, options);
          await runner.commitTransaction();
          this.countStatus(expired ? 'REJECTED' : 'PENDING_REFERENCE');
          const result = {
            transactionId,
            status: expired ? 'REJECTED' : 'PENDING_REFERENCE',
            balance: currentBalance.toJSON(),
            ...(expired ? { failureCode: 'REFERENCE_NOT_FOUND' } : {}),
            idempotentReplay: false,
          };
          this.logResult(input, idempotencyKey, options, result);
          return result;
        }
      }

      let failureCode: string | undefined;
      if (reference) {
        failureCode = this.referenceFailure(input, reference, money);
        if (!failureCode && (input.kind === 'REFUND' || input.kind === 'ROLLBACK')) {
          const reversed = await runner.query(
            `SELECT id FROM wager_transactions
             WHERE reference_transaction_id = $1 AND kind = $2
               AND status IN ('PROCESSED', 'PENDING', 'PENDING_REFERENCE')`,
            [reference.id, input.kind],
          ) as Array<{ id: string }>;
          if (reversed.length) failureCode = 'REFERENCE_ALREADY_REVERSED';
        }
      }

      const balanceMovement = this.movement(input.kind, reference, money);
      if (!failureCode && balanceMovement?.direction === 'DEBIT' &&
          currentBalance.isLessThan(money)) {
        failureCode = 'INSUFFICIENT_FUNDS';
      }

      if (failureCode) {
        await runner.query(
          `UPDATE wager_transactions
           SET status = 'REJECTED', failure_code = $2, result_balance = $3,
               processed_at = now()
           WHERE id = $1`,
          [transactionId, failureCode, currentBalance.toString()],
        );
        await this.enqueueEvent(runner, input.walletId, 'WagerTransactionRejected', {
          transactionId,
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          failureCode,
        });
        await this.markInboxProcessed(runner, options);
        await runner.commitTransaction();
        this.metrics.increment('wager_transactions_total', { status: 'REJECTED' });
        const result = {
          transactionId,
          status: 'REJECTED',
          balance: currentBalance.toJSON(),
          failureCode,
          idempotentReplay: false,
        };
        this.logResult(input, idempotencyKey, options, result);
        return result;
      }

      const nextBalance = balanceMovement
        ? balanceMovement.direction === 'CREDIT'
          ? currentBalance.add(money)
          : currentBalance.subtract(money)
        : currentBalance;
      const nextVersion = balanceMovement ? Number(wallet.version) + 1 : Number(wallet.version);

      if (reference) {
        await runner.query(
          `UPDATE wager_transactions SET reference_transaction_id = $2 WHERE id = $1`,
          [transactionId, reference.id],
        );
      }
      await runner.query(
        `UPDATE wager_transactions
         SET status = 'PROCESSED', result_balance = $2, processed_at = now()
         WHERE id = $1`,
        [transactionId, nextBalance.toString()],
      );

      if (balanceMovement) {
        await runner.query(
          `UPDATE wallets SET balance = $2, version = $3, updated_at = now()
           WHERE id = $1`,
          [input.walletId, nextBalance.toString(), nextVersion],
        );
        await runner.query(
          `INSERT INTO wallet_ledger
            (id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            randomUUID(), input.walletId, transactionId, balanceMovement.direction,
            money.toString(), money.currency, currentBalance.toString(),
            nextBalance.toString(),
          ],
        );
        await this.enqueueEvent(runner, input.walletId, 'WalletBalanceChanged', {
          walletId: input.walletId,
          transactionId,
          direction: balanceMovement.direction,
          money: money.toJSON(),
          balanceBefore: currentBalance.toJSON(),
          balanceAfter: nextBalance.toJSON(),
          walletVersion: nextVersion,
        });
      }
      await this.enqueueEvent(runner, input.walletId, 'WagerTransactionProcessed', {
        transactionId,
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        kind: input.kind,
      });
      await this.markInboxProcessed(runner, options);
      await runner.commitTransaction();
      this.metrics.increment('wager_transactions_total', { status: 'PROCESSED' });
      const result = {
        transactionId,
        status: 'PROCESSED',
        balance: nextBalance.toJSON(),
        idempotentReplay: false,
      };
      this.logResult(input, idempotencyKey, options, result);
      return result;
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (this.isLockConflict(error)) this.metrics.increment('wager_lock_conflicts_total');
      if (this.isUniqueViolation(error)) {
        const prior = await this.findByIdempotencyKey(idempotencyKey);
        if (prior) return this.replay(prior, payloadHash);
        throw new DomainHttpError('TRANSACTION_ID_CONFLICT', HttpStatus.CONFLICT);
      }
      throw error;
    } finally {
      await runner.release();
      this.metrics.observe('wager_processing_duration_ms', Date.now() - startedAt);
    }
  }

  /** Cria uma carteira e registra saldo inicial, OPENING e ledger atomicamente. */
  async createWallet(playerId: string, initial: Money): Promise<Record<string, unknown>> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    const walletId = randomUUID();
    const openingId = randomUUID();
    try {
      await runner.query(
        `INSERT INTO wallets (id, player_id, currency, balance, version)
         VALUES ($1,$2,$3,$4,1)`,
        [walletId, playerId, initial.currency, initial.toString()],
      );
      if (initial.isPositive()) {
        const openingKey = `OPENING:${walletId}`;
        const openingHash = canonicalPayloadHash({
          providerId: 'internal',
          externalTransactionId: openingKey,
          playerId,
          walletId,
          roundId: 'wallet-opening',
          gameId: 'internal',
          kind: 'BET',
          money: initial.toJSON(),
        });
        await runner.query(
          `INSERT INTO wager_transactions
            (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
             wallet_id, player_id, round_id, game_id, kind, amount, currency,
             status, result_balance, processed_at)
           VALUES ($1,'internal',$2,$3,$4,$5,$6,'wallet-opening','internal',
             'OPENING',$7,$8,'PROCESSED',$7,now())`,
          [openingId, openingKey, openingKey, openingHash, walletId, playerId,
            initial.toString(), initial.currency],
        );
        await runner.query(
          `INSERT INTO wallet_ledger
            (id, wallet_id, transaction_id, direction, amount, currency,
             balance_before, balance_after)
           VALUES ($1,$2,$3,'CREDIT',$4,$5,'0.00',$4)`,
          [randomUUID(), walletId, openingId, initial.toString(), initial.currency],
        );
        await this.enqueueEvent(runner, walletId, 'WalletBalanceChanged', {
          walletId,
          transactionId: openingId,
          direction: 'CREDIT',
          money: initial.toJSON(),
          balanceBefore: { amount: '0.00', currency: initial.currency },
          balanceAfter: initial.toJSON(),
          walletVersion: 1,
        });
        await this.enqueueEvent(runner, walletId, 'WagerTransactionProcessed', {
          transactionId: openingId,
          providerId: 'internal',
          externalTransactionId: openingKey,
          kind: 'OPENING',
        });
      }
      await runner.commitTransaction();
      return {
        id: walletId,
        playerId,
        balance: initial.toJSON(),
        version: 1,
      };
    } catch (error) {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      if (this.isLockConflict(error)) this.metrics.increment('wager_lock_conflicts_total');
      if (this.isUniqueViolation(error)) {
        throw new DomainHttpError('WALLET_ALREADY_EXISTS', HttpStatus.CONFLICT);
      }
      throw error;
    } finally {
      await runner.release();
    }
  }

  /** Busca uma carteira e serializa seu saldo sem perda de precisão. */
  async getWallet(walletId: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query(
      `SELECT id, player_id, balance::text, currency, version::text
       FROM wallets WHERE id = $1`,
      [walletId],
    ) as WalletRow[];
    const wallet = rows[0];
    if (!wallet) throw new DomainHttpError('WALLET_NOT_FOUND', HttpStatus.NOT_FOUND);
    return {
      id: wallet.id,
      playerId: wallet.player_id,
      balance: { amount: wallet.balance, currency: wallet.currency.trim() },
      version: Number(wallet.version),
    };
  }

  /** Busca uma transação e retorna seus dados persistidos. */
  async getTransaction(id: string): Promise<Record<string, unknown>> {
    const rows = await this.dataSource.query(
      `SELECT id, provider_id, external_transaction_id, wallet_id, player_id,
              round_id, game_id, kind, amount::text, currency,
              reference_external_transaction_id, status, failure_code,
              result_balance::text, created_at, processed_at
       FROM wager_transactions WHERE id = $1`,
      [id],
    ) as Array<Record<string, unknown>>;
    if (!rows[0]) throw new DomainHttpError('TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND);
    return rows[0];
  }

  /** Localiza uma transação pelos identificadores do provedor. */
  async getProviderTransaction(providerId: string, externalId: string) {
    const rows = await this.dataSource.query(
      `SELECT id FROM wager_transactions
       WHERE provider_id = $1 AND external_transaction_id = $2`,
      [providerId, externalId],
    ) as Array<{ id: string }>;
    if (!rows[0]) {
      throw new DomainHttpError('TRANSACTION_NOT_FOUND', HttpStatus.NOT_FOUND);
    }
    return this.getTransaction(rows[0].id);
  }

  /** Retorna uma página do ledger com cursor opaco e limite validado. */
  async getLedger(walletId: string, cursor?: string, limit = 50) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new DomainHttpError('INVALID_LIMIT', HttpStatus.BAD_REQUEST);
    }
    let decoded: [string, string] | undefined;
    if (cursor) {
      try {
        const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (!Array.isArray(parsed) || parsed.length !== 2 ||
            typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string') {
          throw new Error('invalid cursor');
        }
        if (!Number.isFinite(Date.parse(parsed[0])) ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
              .test(parsed[1])) {
          throw new Error('invalid cursor');
        }
        decoded = [parsed[0], parsed[1]];
      } catch {
        throw new DomainHttpError('INVALID_CURSOR', HttpStatus.BAD_REQUEST);
      }
    }
    const wallets = await this.dataSource.query(
      `SELECT id FROM wallets WHERE id = $1`,
      [walletId],
    ) as Array<{ id: string }>;
    if (!wallets[0]) throw new DomainHttpError('WALLET_NOT_FOUND', HttpStatus.NOT_FOUND);
    const rows = await this.dataSource.query(
      `SELECT id, transaction_id, direction, amount::text, currency,
              balance_before::text, balance_after::text, created_at
       FROM wallet_ledger
       WHERE wallet_id = $1
         AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
       ORDER BY created_at DESC, id DESC
       LIMIT $4`,
      [walletId, decoded?.[0] ?? null, decoded?.[1] ?? null, limit + 1],
    ) as Array<Record<string, unknown>>;
    const hasMore = rows.length > limit;
    const entries = rows.slice(0, limit);
    const last = entries[entries.length - 1];
    return {
      entries,
      nextCursor: hasMore && last
        ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url')
        : null,
    };
  }

  /** Reconstrói o saldo pelo ledger e informa divergências com a carteira. */
  async reconcile(walletId: string) {
    const rows = await this.dataSource.query(
      `SELECT w.balance::text AS stored_balance, w.currency,
              COALESCE(SUM(CASE WHEN l.direction = 'CREDIT' THEN l.amount
                                ELSE -l.amount END), 0)::numeric(20,2)::text AS calculated_balance,
              COUNT(l.id)::int AS checked_entries
       FROM wallets w
       LEFT JOIN wallet_ledger l ON l.wallet_id = w.id
       WHERE w.id = $1
       GROUP BY w.id`,
      [walletId],
    ) as Array<{
      stored_balance: string;
      currency: string;
      calculated_balance: string;
      checked_entries: number;
    }>;
    const row = rows[0];
    if (!row) throw new DomainHttpError('WALLET_NOT_FOUND', HttpStatus.NOT_FOUND);
    const stored = Money.from({ amount: row.stored_balance, currency: row.currency.trim() });
    const difference = this.absoluteDifference(
      stored.toJSON().amount,
      row.calculated_balance,
    );
    const consistent = stored.toJSON().amount === row.calculated_balance;
    if (!consistent) {
      this.metrics.increment('wallet_reconciliation_mismatches_total');
      console.error(JSON.stringify({
        event: 'wallet_reconciliation_mismatch',
        walletId,
        storedBalance: stored.toString(),
        calculatedBalance: row.calculated_balance,
      }));
    }
    return {
      walletId,
      storedBalance: stored.toJSON(),
      calculatedBalance: {
        amount: row.calculated_balance,
        currency: stored.currency,
      },
      difference: { amount: consistent ? '0.00' : difference, currency: stored.currency },
      consistent,
      checkedEntries: Number(row.checked_entries),
    };
  }

  /** Calcula a diferença absoluta entre dois valores decimais exatos. */
  private absoluteDifference(left: string, right: string): string {
    const toCents = (amount: string) => {
      const negative = amount.startsWith('-');
      const [units, fraction] = (negative ? amount.slice(1) : amount).split('.');
      const cents = BigInt(units) * 100n + BigInt(fraction);
      return negative ? -cents : cents;
    };
    const cents = toCents(left) - toCents(right);
    const absolute = cents < 0n ? -cents : cents;
    return `${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
  }

  /** Determina se uma operação altera o saldo e em qual direção. */
  private movement(
    kind: string,
    reference: TransactionRow | undefined,
    _money: Money,
  ): { direction: 'DEBIT' | 'CREDIT' } | undefined {
    if (kind === 'BET') return { direction: 'DEBIT' };
    if (kind === 'WIN' || kind === 'REFUND') return { direction: 'CREDIT' };
    if (kind === 'LOSS') return undefined;
    if (kind === 'ROLLBACK' && reference) {
      return reference.kind === 'BET' || reference.kind === 'ROLLBACK'
        ? { direction: 'CREDIT' }
        : { direction: 'DEBIT' };
    }
    return undefined;
  }

  /** Verifica estado, contexto, tipo e valor da transação referenciada. */
  private referenceFailure(
    input: WagerInput,
    reference: TransactionRow,
    money: Money,
  ): string | undefined {
    if (reference.status !== 'PROCESSED') return 'REFERENCE_NOT_PROCESSED';
    if (reference.provider_id !== input.providerId ||
        reference.player_id !== input.playerId ||
        reference.wallet_id !== input.walletId ||
        reference.currency.trim() !== money.currency ||
        reference.round_id !== input.roundId) {
      return 'REFERENCE_CONTEXT_MISMATCH';
    }
    if (input.kind === 'REFUND' && reference.kind !== 'BET') {
      return 'INVALID_REFUND_REFERENCE';
    }
    if (input.kind === 'WIN' && reference.kind !== 'BET') {
      return 'INVALID_WIN_REFERENCE';
    }
    if (input.kind === 'ROLLBACK' &&
        !['BET', 'WIN', 'REFUND'].includes(reference.kind)) {
      return 'INVALID_ROLLBACK_REFERENCE';
    }
    if ((input.kind === 'REFUND' || input.kind === 'ROLLBACK') &&
        reference.amount.trim() !== money.toString()) {
      return 'REFERENCE_AMOUNT_MISMATCH';
    }
    return undefined;
  }

  /** Grava um evento versionado na Outbox dentro da transação atual. */
  private async enqueueEvent(
    runner: QueryRunner,
    aggregateId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const occurredAt = new Date();
    const payload = {
      eventId: randomUUID(),
      eventType,
      aggregateId,
      correlationId: randomUUID(),
      occurredAt: occurredAt.toISOString(),
      version: 1,
      data,
    };
    await runner.query(
      `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
       VALUES ($1,$2,$3,$4::jsonb,$5)`,
      [payload.eventId, aggregateId, eventType, JSON.stringify(payload), occurredAt],
    );
  }

  /** Marca como processada a mensagem Inbox da entrega SQS atual. */
  private async markInboxProcessed(
    runner: QueryRunner,
    options: ProcessOptions,
  ): Promise<void> {
    if (!options.messageId || !options.consumerName) return;
    await runner.query(
      `UPDATE inbox_messages SET processed_at = now()
       WHERE consumer_name = $1 AND message_id = $2`,
      [options.consumerName, options.messageId],
    );
  }

  /** Busca uma transação pela chave idempotente na transação atual ou no banco. */
  private async findByIdempotencyKey(
    key: string,
    runner?: QueryRunner,
  ): Promise<TransactionRow | undefined> {
    const query = `SELECT * FROM wager_transactions WHERE idempotency_key = $1`;
    const rows = runner
      ? await runner.query(query, [key])
      : await this.dataSource.query(query, [key]);
    return (rows as TransactionRow[])[0];
  }

  /** Compara o hash e recompõe a resposta original de uma solicitação repetida. */
  private replay(row: TransactionRow, payloadHash: string): ProcessResult {
    if (row.payload_hash.trim() !== payloadHash) {
      throw new DomainHttpError('IDEMPOTENCY_KEY_PAYLOAD_CONFLICT', HttpStatus.CONFLICT);
    }
    this.metrics.increment('wager_idempotent_replays_total');
    this.metrics.increment('wager_transactions_total', { status: row.status });
    return {
      transactionId: row.id,
      status: row.status,
      ...(row.result_balance
        ? { balance: { amount: row.result_balance, currency: row.currency.trim() } }
        : {}),
      ...(row.failure_code ? { failureCode: row.failure_code } : {}),
      idempotentReplay: true,
    };
  }

  /** Incrementa a métrica de transações para o status informado. */
  private countStatus(status: string): void {
    this.metrics.increment('wager_transactions_total', { status });
  }

  /** Registra o resultado com identificadores de correlação, sem dados financeiros. */
  private logResult(
    input: WagerInput,
    idempotencyKey: string,
    options: ProcessOptions,
    result: ProcessResult,
  ): void {
    console.info(JSON.stringify({
      event: 'wager_transaction_result',
      correlationId: options.messageId ?? idempotencyKey,
      messageId: options.messageId ?? null,
      transactionId: result.transactionId,
      walletId: input.walletId,
      providerId: input.providerId,
      status: result.status,
    }));
  }

  /** Identifica uma violação de constraint de unicidade do PostgreSQL. */
  private isUniqueViolation(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error &&
      (error as { code?: string }).code === '23505';
  }

  /** Identifica conflitos de lock ou serialização retornados pelo PostgreSQL. */
  private isLockConflict(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error &&
      ['40P01', '40001', '55P03'].includes((error as { code?: string }).code ?? '');
  }

  /** Busca periodicamente referências pendentes e tenta concluir suas transações. */
  private async retryPendingReferences(): Promise<void> {
    while (!this.stopping) {
      try {
        const pending = await this.dataSource.query(
          `SELECT provider_id, external_transaction_id, idempotency_key, player_id,
                  wallet_id, round_id, game_id, kind, amount::text, currency,
                  reference_external_transaction_id
           FROM wager_transactions
           WHERE status = 'PENDING_REFERENCE' AND next_attempt_at <= now()
           ORDER BY next_attempt_at
           LIMIT 20`,
        ) as Array<{
          provider_id: string;
          external_transaction_id: string;
          idempotency_key: string;
          player_id: string;
          wallet_id: string;
          round_id: string;
          game_id: string;
          kind: WagerInput['kind'];
          amount: string;
          currency: string;
          reference_external_transaction_id: string;
        }>;
        for (const row of pending) {
          if (this.stopping) break;
          try {
            await this.process({
              providerId: row.provider_id,
              externalTransactionId: row.external_transaction_id,
              playerId: row.player_id,
              walletId: row.wallet_id,
              roundId: row.round_id,
              gameId: row.game_id,
              kind: row.kind,
              money: { amount: row.amount, currency: row.currency.trim() },
              referenceExternalTransactionId: row.reference_external_transaction_id,
            }, row.idempotency_key);
          } catch (error) {
            console.error(JSON.stringify({
              event: 'pending_reference_retry_failed',
              transactionId: row.external_transaction_id,
              message: error instanceof Error ? error.message : 'unknown',
            }));
          }
        }
      } catch (error) {
        console.error(JSON.stringify({
          event: 'pending_reference_worker_error',
          message: error instanceof Error ? error.message : 'unknown',
        }));
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}
