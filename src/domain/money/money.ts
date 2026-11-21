import Decimal from "decimal.js";
import { DomainError } from "../shared/domain-error";

export interface MoneyProps {
    amount: string;
    currency: string;
}

const D = Decimal.clone({ precision: 40 });

const AMOUNT_INPUT_REGEX = /^\d{1,18}(\.\d{1,2})?$/;
const CURRENCY_INPUT_REGEX = /^[A-Z]{3}$/;
const MAX_ABS = new D("999999999999999999.99");
const SUPPORTED_CURRENCIES = new Set(["BRL", "USD", "EUR"]);

export class Money {
    private constructor(
        private readonly value: Decimal,
        public readonly currency: string
    ){}
    
    static from(props: MoneyProps): Money {
        const { amount, currency } = props;

        if(typeof amount !== "string" || !AMOUNT_INPUT_REGEX.test(amount))
            throw new DomainError("INVALID_AMOUNT", `Valor inválido: ${amount}` );
        
        if (typeof currency !== "string" || !CURRENCY_INPUT_REGEX.test(currency) || !SUPPORTED_CURRENCIES.has(currency)) 
            throw new DomainError("INVALID_CURRENCY", `Moeda inválida ou não suportada: ${currency}`);
        
        return Money.of(new D(amount), currency);
    }

    private static of (value: Decimal, currency: string): Money {
        if (value.abs().gt(MAX_ABS)) {
            throw new DomainError("AMOUNT_OUT_OF_RANGE", `Valor fora do intervalo permitido: ${value.toString()}`);
        }
        return new Money(value, currency);
    }

    static rehydrate(props: MoneyProps): Money {
        return Money.of(new D(props.amount), props.currency); 
    }
    
    static zero(currency: string): Money {
        return Money.from({ amount: '0.00', currency });
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return Money.of(this.value.plus(other.value), this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return Money.of(this.value.minus(other.value), this.currency);
    }

    negate(): Money {
        if (this.isZero()) {
            return this;
        }
        return Money.of(this.value.negated(), this.currency);
    }

    isZero(): boolean {
        return this.value.isZero();
    }

    isPositive(): boolean {
        return this.value.gt(0);
    }

    isNegative(): boolean {
        return this.value.lt(0);
    }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.lt(other.value);
    }

    equals(other: Money): boolean {
        if (!(other instanceof Money) || !other) return false
        return this.currency === other.currency && this.value.equals(other.value);
    }

    toJSON(): MoneyProps {
        return {
            amount: this.format(),
            currency: this.currency
        }
    }

    toString(): string {
        return `${this.format()} ${this.currency}`;
    }

    private format(): string{
        return this.value.isZero() ? '0.00' : this.value.toFixed(2)
    }

    private assertSameCurrency(other: Money): void{
        if (this.currency !== other.currency) {
            throw new DomainError(
                "CURRENCY_MISMATCH",
                `Moedas diferentes: ${this.currency} e ${other.currency}`
            )
        }
    }
}