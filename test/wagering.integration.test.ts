import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { dataSource } from '../src/database/data-source';
import { Money } from '../src/domain/money';
import { WagerInput } from '../src/domain/wager';
import { MetricsService } from '../src/services/metrics.service';
import { NoopProviderIdentityAdapter } from '../src/auth/provider-identity.port';
import { WageringService } from '../src/services/wagering.service';

const integration = process.env.RUN_INTEGRATION_TESTS === '1';

describe.skipIf(!integration)('PostgreSQL wagering concurrency', () => {
  let service: WageringService;

  beforeAll(async () => {
    await dataSource.initialize();
    await dataSource.runMigrations({ transaction: 'all' });
    service = new WageringService(
      dataSource,
      new MetricsService(),
      new NoopProviderIdentityAdapter(),
    );
  });

  afterAll(async () => {
    if (dataSource.isInitialized) await dataSource.destroy();
  });

  test('50 simultaneous deliveries produce one debit', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(
      playerId,
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const walletId = String(wallet.id);
    const input: WagerInput = {
      providerId: 'integration-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'concurrency-round',
      gameId: 'test-game',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const key = `${input.providerId}:${input.externalTransactionId}`;

    const results = await Promise.all(
      Array.from({ length: 50 }, () => service.process(input, key)),
    );
    const ledger = await dataSource.query(
      `SELECT count(*)::int AS count FROM wallet_ledger WHERE wallet_id = $1`,
      [walletId],
    ) as Array<{ count: number }>;
    const currentWallet = await service.getWallet(walletId);

    expect(new Set(results.map((result) => result.transactionId)).size).toBe(1);
    expect(ledger[0].count).toBe(2);
    expect(currentWallet.balance).toEqual({ amount: '75.00', currency: 'BRL' });
  });

  test('competing bets cannot overdraw a wallet', async () => {
    const playerId = randomUUID();
    const wallet = await service.createWallet(
      playerId,
      Money.from({ amount: '100.00', currency: 'BRL' }),
    );
    const walletId = String(wallet.id);
    const createBet = (): WagerInput => ({
      providerId: 'integration-provider',
      externalTransactionId: randomUUID(),
      playerId,
      walletId,
      roundId: 'funds-round',
      gameId: 'test-game',
      kind: 'BET',
      money: { amount: '80.00', currency: 'BRL' },
    });
    const wagers = [createBet(), createBet()];
    const results = await Promise.all(
      wagers.map((wager) => service.process(
        wager,
        `${wager.providerId}:${wager.externalTransactionId}`,
      )),
    );
    const statuses = results.map((result) => result.status).sort();
    const ledger = await dataSource.query(
      `SELECT count(*)::int AS count FROM wallet_ledger
       WHERE wallet_id = $1 AND direction = 'DEBIT'`,
      [walletId],
    ) as Array<{ count: number }>;

    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(ledger[0].count).toBe(1);
    expect((await service.getWallet(walletId)).balance)
      .toEqual({ amount: '20.00', currency: 'BRL' });
  });
});
