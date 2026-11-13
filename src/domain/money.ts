export interface MoneyProps {
  amount: string;
  currency: string;
}

const AMOUNT_PATTERN = /^(0|[1-9]\d*)\.\d{2}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  /** Cria um valor monetário imutável a partir de centavos e moeda. */
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Valida e converte uma string decimal para centavos exatos. */
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

  /** Cria o valor zero para a moeda informada. */
  static zero(currency: string): Money {
    return Money.from({ amount: '0.00', currency });
  }

  /** Cria um valor a partir de centavos, rejeitando valores negativos. */
  static fromCents(cents: bigint, currency: string): Money {
    if (cents < 0n) throw new Error('NEGATIVE_MONEY');
    return new Money(cents, currency);
  }

  /** Soma dois valores da mesma moeda e retorna uma nova instância. */
  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromCents(this.cents + other.cents, this.currency);
  }

  /** Subtrai outro valor da mesma moeda sem permitir resultado negativo. */
  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    if (this.cents < other.cents) throw new Error('NEGATIVE_MONEY');
    return Money.fromCents(this.cents - other.cents, this.currency);
  }

  /** Retorna uma nova instância com o sinal do valor invertido. */
  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  /** Informa se o valor monetário é zero. */
  isZero(): boolean {
    return this.cents === 0n;
  }

  /** Informa se o valor monetário é maior que zero. */
  isPositive(): boolean {
    return this.cents > 0n;
  }

  /** Informa se o valor monetário é menor que zero. */
  isNegative(): boolean {
    return this.cents < 0n;
  }

  /** Compara este valor com outro da mesma moeda. */
  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  /** Verifica se valor e moeda são iguais aos de outro objeto Money. */
  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  /** Serializa o valor em string decimal com duas casas e sua moeda. */
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

  /** Retorna apenas o valor decimal, mantendo sempre duas casas. */
  toString(): string {
    return this.toJSON().amount;
  }

  /** Impede operações aritméticas entre moedas diferentes. */
  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) throw new Error('CURRENCY_MISMATCH');
  }
}
