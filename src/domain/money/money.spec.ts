import {describe, expect, it} from "bun:test";
import { DomainError } from '../shared/domain-error'
import { Money } from './money'

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

function codeOf(fn: () => unknown): string | undefined {
    try {
        fn();
    } catch (e) {
        return (e as DomainError).code;
    }
    return undefined;
}

describe("Money - Construção", () => {
        it.each([
            ['25', '25.00'],
            ['25.5', '25.50'],
            ['25.50', '25.50'],
            ['0', '0.00'],
        ])('normaliza %p para para %p ', (input, expected) => {
            expect(brl(input).toJSON()).toEqual({amount: expected, currency:"BRL"})
        });

        it.each([
            '', ' ', 'NaN', 'Infinity', '-Infinity', '1e3', '1E3',
            '-5.00', '+5', '25.001', '.5', '5.', '1,50', '0x10', '9'.repeat(19),
        ])("rejeita %p como valor inválido ", (input) => {
            expect(() => brl(input)).toThrowError(DomainError);
        })

        it("rejeita amount que não seja string", () => {
            expect(() => Money.from({amount: 25 as unknown as string, currency: 'BRL'})).toThrowError(DomainError);
        })

        it.each(['', 'br', 'BRLL', 'brl', '123'])('rejeita moeda inválida %p', (currency) => {
            expect(() => Money.from({ amount: '1.00', currency })).toThrow(DomainError);
        });
    }
)

describe('Money — operações', () => {
    it('soma sem erro de ponto flutuante', () => {
        expect(brl('0.10').add(brl('0.20')).toJSON().amount).toBe('0.30');
    });

    it('é imutável: operações retornam nova instância', () => {
        const a = brl('10.00');
        const b = a.add(brl('5.00'));
        expect(a.toJSON().amount).toBe('10.00');
        expect(b.toJSON().amount).toBe('15.00');
    });

    it('subtract pode resultar em negativo (usado para detectar saldo insuficiente)', () => {
        const r = brl('10.00').subtract(brl('10.01'));
        expect(r.isNegative()).toBe(true);
        expect(r.toJSON().amount).toBe('-0.01');
    });

    it('negate de zero não gera "-0.00"', () => {
        expect(brl('0').negate().toJSON().amount).toBe('0.00');
    });

    it('isZero, isPositive e isLessThan', () => {
        expect(brl('0.00').isZero()).toBe(true);
        expect(brl('0.01').isPositive()).toBe(true);
        expect(brl('1.00').isLessThan(brl('1.01'))).toBe(true);
        expect(brl('1.01').isLessThan(brl('1.00'))).toBe(false);
    });

    it('equals considera valor e moeda', () => {
        expect(brl('10.00').equals(brl('10'))).toBe(true);
        expect(brl('10.00').equals(usd('10.00'))).toBe(false);
    });

    it('operações entre moedas diferentes lançam CURRENCY_MISMATCH', () => {
        expect(codeOf(() => brl('1').add(usd('1')))).toBe('CURRENCY_MISMATCH');
        expect(codeOf(() => brl('1').subtract(usd('1')))).toBe('CURRENCY_MISMATCH');
        expect(codeOf(() => brl('1').isLessThan(usd('1')))).toBe('CURRENCY_MISMATCH');
    });

    it('rejeita resultado acima do limite de numeric(20,2)', () => {
        expect(codeOf(() => brl('999999999999999999.99').add(brl('0.01')))).toBe(
        'AMOUNT_OUT_OF_RANGE',
        );
    });
});

describe('Money — serialização', () => {
    it('toJSON gera JSON estável com string decimal', () => {
        expect(JSON.stringify({ money: brl('25') })).toBe(
        '{"money":{"amount":"25.00","currency":"BRL"}}',
        );
    });

    it('toString inclui a moeda', () => {
        expect(brl('25').toString()).toBe('25.00 BRL');
    });
});