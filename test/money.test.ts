import { describe, expect, test } from 'bun:test';
import { Money } from '../src/domain/money';
import {
  canonicalPayloadHash,
  validateWagerInput,
  WagerInput,
} from '../src/domain/wager';

describe('Money', () => {
  test('performs exact decimal arithmetic and serializes with fixed scale', () => {
    const balance = Money.from({ amount: '100.00', currency: 'BRL' });
    const stake = Money.from({ amount: '80.01', currency: 'BRL' });
    expect(balance.subtract(stake).toJSON()).toEqual({
      amount: '19.99',
      currency: 'BRL',
    });
    expect(Money.from({ amount: '1.05', currency: 'BRL' })
      .add(Money.from({ amount: '0.95', currency: 'BRL' })).toString())
      .toBe('2.00');
  });

  test('rejects invalid scales, scientific notation, negative inputs, and currencies', () => {
    for (const amount of ['1', '1.000', '1e2', '-1.00', 'NaN', '']) {
      expect(() => Money.from({ amount, currency: 'BRL' })).toThrow();
    }
    expect(() => Money.from({ amount: '1.00', currency: 'brl' })).toThrow();
  });

  test('rejects arithmetic across currencies', () => {
    expect(() => Money.from({ amount: '1.00', currency: 'BRL' })
      .add(Money.from({ amount: '1.00', currency: 'USD' })))
      .toThrow('CURRENCY_MISMATCH');
  });

  test('serializes a negative intermediate value without floating point', () => {
    expect(Money.from({ amount: '1.50', currency: 'BRL' }).negate().toJSON())
      .toEqual({ amount: '-1.50', currency: 'BRL' });
  });
});

describe('Wager request validation', () => {
  const wager: WagerInput = {
    providerId: 'provider-a',
    externalTransactionId: 'tx-1',
    playerId: 'player-1',
    walletId: 'wallet-1',
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount: '25.00', currency: 'BRL' },
  };

  test('canonical payload hashing is deterministic and ignores object key order', () => {
    const reordered = {
      ...wager,
      money: { currency: 'BRL', amount: '25.00' },
    };
    expect(canonicalPayloadHash(wager)).toBe(canonicalPayloadHash(reordered));
  });

  test('requires a reference for refunds and rollbacks', () => {
    expect(() => validateWagerInput({ ...wager, kind: 'REFUND' }))
      .toThrow('REFERENCE_REQUIRED');
  });
});
