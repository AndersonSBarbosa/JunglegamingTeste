import { createHash } from 'node:crypto';
import { Money } from './money';

export const wagerKinds = ['BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'] as const;
export type WagerKind = (typeof wagerKinds)[number];

export interface WagerInput {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/** Ordena recursivamente as chaves para produzir JSON determinístico. */
function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortObjectKeys(nested)]),
  );
}

/** Calcula o SHA-256 dos campos de negócio em uma representação canônica. */
export function canonicalPayloadHash(input: WagerInput): string {
  const canonical = JSON.stringify(sortObjectKeys({
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: input.money,
    playerId: input.playerId,
    providerId: input.providerId,
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
    roundId: input.roundId,
    walletId: input.walletId,
  }));
  return createHash('sha256').update(canonical).digest('hex');
}

/** Valida os campos da aposta e retorna seu valor como Money. */
export function validateWagerInput(input: WagerInput): Money {
  for (const [field, value] of Object.entries({
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
  })) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`INVALID_${field.toUpperCase()}`);
    }
  }
  if (!wagerKinds.includes(input.kind)) throw new Error('INVALID_KIND');
  if ((input.kind === 'REFUND' || input.kind === 'ROLLBACK') &&
      !input.referenceExternalTransactionId) {
    throw new Error('REFERENCE_REQUIRED');
  }
  if (input.kind !== 'REFUND' && input.kind !== 'ROLLBACK' &&
      input.referenceExternalTransactionId) {
    throw new Error('UNEXPECTED_REFERENCE');
  }
  const money = Money.from(input.money);
  if (!money.isPositive()) throw new Error('AMOUNT_MUST_BE_POSITIVE');
  return money;
}
