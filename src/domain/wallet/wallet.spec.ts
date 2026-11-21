import { describe, expect, it } from "bun:test";
import { DomainError } from "../shared/domain-error";
import { Money } from "../money/money";
import { LedgerDirection } from "./wallet_ledger_entry";
import { Wallet } from "./wallet";

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

describe("Wallet — Criação e Reidratação", () => {
    it("abre wallet com saldo inicial e version 1", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        expect(wallet.id).toBe("w-1");
        expect(wallet.playerId).toBe("p-1");
        expect(wallet.currency).toBe("BRL");
        expect(wallet.balance.toJSON().amount).toBe("100.00");
        expect(wallet.version).toBe(1);
        expect(wallet.createdAt).toBeInstanceOf(Date);
        expect(wallet.updatedAt).toBeInstanceOf(Date);
    });

    it("abre wallet com saldo zero", () => {
        const wallet = Wallet.open({
        id: "w-2",
        playerId: "p-2",
        initialBalance: brl("0.00"),
        });

        expect(wallet.balance.isZero()).toBe(true);
        expect(wallet.version).toBe(1);
    });

    it("rejeita abertura de wallet com saldo inicial negativo", () => {
        const negativeMoney = brl("10.00").negate(); // -10.00
        expect(codeOf(() => Wallet.open({
        id: "w-3",
        playerId: "p-3",
        initialBalance: negativeMoney,
        }))).toBe("INITIAL_BALANCE_NEGATIVE");
    });

    it("rejeita abertura com id ou playerId ausentes", () => {
        expect(() => Wallet.open({ id: "", playerId: "p-1", initialBalance: brl("0.00") })).toThrow(DomainError);
        expect(() => Wallet.open({ id: "w-1", playerId: "", initialBalance: brl("0.00") })).toThrow(DomainError);
    });

    it("reidrata wallet a partir do estado persistido sem alterar a versão", () => {
        const createdAt = new Date("2026-01-01T10:00:00.000Z");
        const updatedAt = new Date("2026-01-01T12:00:00.000Z");

        const wallet = Wallet.rehydrate({
        id: "w-rehydrated",
        playerId: "p-rehydrated",
        currency: "BRL",
        balance: { amount: "250.75", currency: "BRL" },
        version: 5,
        createdAt,
        updatedAt,
        });

        expect(wallet.id).toBe("w-rehydrated");
        expect(wallet.playerId).toBe("p-rehydrated");
        expect(wallet.balance.toJSON().amount).toBe("250.75");
        expect(wallet.version).toBe(5);
        expect(wallet.createdAt.toISOString()).toBe(createdAt.toISOString());
        expect(wallet.updatedAt.toISOString()).toBe(updatedAt.toISOString());
    });
});

describe("Wallet — Operação de Débito", () => {
    it("realiza débito com sucesso, atualiza saldo, incrementa versão e gera ledger", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        const now = new Date();
        const entry = wallet.debit({
        ledgerEntryId: "l-1",
        transactionId: "tx-1",
        money: brl("40.00"),
        at: now,
        });

        expect(wallet.balance.toJSON().amount).toBe("60.00");
        expect(wallet.version).toBe(2);
        expect(wallet.updatedAt).toEqual(now);

        expect(entry.id).toBe("l-1");
        expect(entry.walletId).toBe("w-1");
        expect(entry.transactionId).toBe("tx-1");
        expect(entry.direction).toBe(LedgerDirection.Debit);
        expect(entry.money.toJSON().amount).toBe("40.00");
        expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
        expect(entry.balanceAfter.toJSON().amount).toBe("60.00");
    });

    it("permite debitar exatamente 100% do saldo restante", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("50.00"),
        });

        wallet.debit({
        ledgerEntryId: "l-1",
        transactionId: "tx-1",
        money: brl("50.00"),
        });

        expect(wallet.balance.isZero()).toBe(true);
        expect(wallet.version).toBe(2);
    });

    it("rejeita débito se saldo for insuficiente e preserva estado da wallet", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        expect(codeOf(() => wallet.debit({
        ledgerEntryId: "l-1",
        transactionId: "tx-1",
        money: brl("100.01"),
        }))).toBe("INSUFFICIENT_FUNDS");

        // Invariante: saldo e versão não mudam
        expect(wallet.balance.toJSON().amount).toBe("100.00");
        expect(wallet.version).toBe(1);
    });

    it("rejeita débito com saldo zero", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("0.00"),
        });

        expect(codeOf(() => wallet.debit({
        ledgerEntryId: "l-1",
        transactionId: "tx-1",
        money: brl("10.00"),
        }))).toBe("INSUFFICIENT_FUNDS");
    });

    it("rejeita débito com valor zero ou negativo", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        expect(codeOf(() => wallet.debit({
        ledgerEntryId: "l-1",
        transactionId: "tx-1",
        money: brl("0.00"),
        }))).toBe("INVALID_DEBIT_AMOUNT");

        expect(codeOf(() => wallet.debit({
        ledgerEntryId: "l-2",
        transactionId: "tx-2",
        money: brl("10.00").negate(),
        }))).toBe("INVALID_DEBIT_AMOUNT");
    });

    it("rejeita débito com moeda incompatível", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        expect(codeOf(() => wallet.debit({
        ledgerEntryId: "l-1",
        transactionId: "tx-1",
        money: usd("10.00"),
        }))).toBe("CURRENCY_MISMATCH");
    });

    it("rejeita debito com ledgerEntryId ou transactionId inválido", ()=>{const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        expect(codeOf(() => wallet.debit({
        ledgerEntryId: "",
        transactionId: "tx-1",
        money: brl("10.00"),
        }))).toBe("INVALID_ID");

        expect(codeOf(() => wallet.debit({
        ledgerEntryId: "l-1",
        transactionId: "",
        money: brl("10.00"),
        }))).toBe("INVALID_ID");

        expect(codeOf(() => wallet.debit({
        ledgerEntryId: "",
        transactionId: "",
        money: brl("10.00"),
        }))).toBe("INVALID_ID");
        
    })
});

describe("Wallet — Operação de Crédito", () => {
    it("realiza crédito com sucesso, atualiza saldo, incrementa versão e gera ledger", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        const now = new Date();
        const entry = wallet.credit({
        ledgerEntryId: "l-1",
        transactionId: "tx-win",
        money: brl("50.00"),
        at: now,
        });

        expect(wallet.balance.toJSON().amount).toBe("150.00");
        expect(wallet.version).toBe(2);
        expect(wallet.updatedAt).toEqual(now);

        expect(entry.id).toBe("l-1");
        expect(entry.direction).toBe(LedgerDirection.Credit);
        expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
        expect(entry.balanceAfter.toJSON().amount).toBe("150.00");
    });

    it("rejeita crédito com valor zero ou negativo", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        expect(codeOf(() => wallet.credit({
        ledgerEntryId: "l-1",
        transactionId: "tx-1",
        money: brl("0.00"),
        }))).toBe("INVALID_CREDIT_AMOUNT");

        expect(codeOf(() => wallet.credit({
        ledgerEntryId: "l-2",
        transactionId: "tx-2",
        money: brl("20.00").negate(),
        }))).toBe("INVALID_CREDIT_AMOUNT");
    });

    it("rejeita crédito com moeda incompatível", () => {
        const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        expect(codeOf(() => wallet.credit({
        ledgerEntryId: "l-1",
        transactionId: "tx-1",
        money: usd("50.00"),
        }))).toBe("CURRENCY_MISMATCH");
    });

    it("rejeita crédito com ledgerEntryId ou transactionId inválido", ()=>{const wallet = Wallet.open({
        id: "w-1",
        playerId: "p-1",
        initialBalance: brl("100.00"),
        });

        expect(codeOf(() => wallet.credit({
        ledgerEntryId: "",
        transactionId: "tx-1",
        money: brl("10.00"),
        }))).toBe("INVALID_ID");

        expect(codeOf(() => wallet.credit({
        ledgerEntryId: "l-1",
        transactionId: "",
        money: brl("10.00"),
        }))).toBe("INVALID_ID");

        expect(codeOf(() => wallet.credit({
        ledgerEntryId: "",
        transactionId: "",
        money: brl("10.00"),
        }))).toBe("INVALID_ID");
    })
});