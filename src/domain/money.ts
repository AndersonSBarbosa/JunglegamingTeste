export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!CURRENCY_PATTERN.test(props.currency)) {
      throw new Error('INVALID_CURRENCY');
    }
    if (!AMOUNT_PATTERN.test(props.amount)) {
      throw new Error('INVALID_AMOUNT');
    }
    const [units, fraction] = props.amount.split('.');
    if (units.length > 18) throw new Error('INVALID_AMOUNT');
    return new Money(BigInt(units) * 100n + BigInt(fraction), props.currency);
  }

  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  static fromCents(cents: bigint, currency: string): Money {
    if (cents < 0n) throw new Error('NEGATIVE_MONEY');
    return new Money(cents, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (this.cents < other.cents) throw new Error('NEGATIVE_MONEY');
    return Money.fromCents(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }

  isPositive(): boolean {
    return this.cents > 0n;
  }

  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    const absolute = this.cents < 0n ? -this.cents : this.cents;
    const sign = this.cents < 0n ? '-' : '';
    const units = absolute / 100n;
    const fraction = absolute % 100n;
    return {
      amount: `${sign}${units}.${fraction.toString().padStart(2, '0')}`,
      currency: this.currency,
    };
  }

  toString(): string {
    return this.toJSON().amount;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
  }
}
