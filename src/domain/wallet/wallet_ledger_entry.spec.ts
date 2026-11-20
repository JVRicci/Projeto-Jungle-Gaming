import { describe, expect, it } from "bun:test";
import { DomainError } from "../shared/domain-error";
import { Money } from "../money/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet_ledger_entry";

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

describe("WalletLedgerEntry — Criação e Equilíbrio", () => {
    it("cria entrada de débito balanceada com sucesso", () => {
        const now = new Date();
        const entry = WalletLedgerEntry.create({
            id: "l-1",
            walletId: "w-1",
            transactionId: "tx-1",
            direction: LedgerDirection.Debit,
            money: brl("25.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("75.00"),
            createdAt: now,
        });

        expect(entry.id).toBe("l-1");
        expect(entry.walletId).toBe("w-1");
        expect(entry.transactionId).toBe("tx-1");
        expect(entry.direction).toBe(LedgerDirection.Debit);
        expect(entry.money.toJSON().amount).toBe("25.00");
        expect(entry.balanceBefore.toJSON().amount).toBe("100.00");
        expect(entry.balanceAfter.toJSON().amount).toBe("75.00");
        expect(entry.createdAt).toEqual(now);
        expect(entry.isBalanced()).toBe(true);
    });

    it("cria entrada de crédito balanceada com sucesso", () => {
        const entry = WalletLedgerEntry.create({
            id: "l-2",
            walletId: "w-1",
            transactionId: "tx-2",
            direction: LedgerDirection.Credit,
            money: brl("50.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("150.00"),
        });

        expect(entry.direction).toBe(LedgerDirection.Credit);
        expect(entry.balanceAfter.toJSON().amount).toBe("150.00");
        expect(entry.isBalanced()).toBe(true);
    });

    it("rejeita entrada de débito quando a conta não fecha", () => {
        expect(codeOf(() => WalletLedgerEntry.create({
            id: "l-err",
            walletId: "w-1",
            transactionId: "tx-1",
            direction: LedgerDirection.Debit,
            money: brl("25.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("80.00"), // Deveria ser 75.00
        }))).toBe("LEDGER_ENTRY_NOT_BALANCED");
    });

    it("rejeita entrada de crédito quando a conta não fecha", () => {
        expect(codeOf(() => WalletLedgerEntry.create({
            id: "l-err",
            walletId: "w-1",
            transactionId: "tx-1",
            direction: LedgerDirection.Credit,
            money: brl("50.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("140.00"), // Deveria ser 150.00
        }))).toBe("LEDGER_ENTRY_NOT_BALANCED");
    });

    it("rejeita lançamento com valor zero ou negativo", () => {
        expect(codeOf(() => WalletLedgerEntry.create({
            id: "l-zero",
            walletId: "w-1",
            transactionId: "tx-1",
            direction: LedgerDirection.Credit,
            money: brl("0.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("100.00"),
        }))).toBe("INVALID_LEDGER_AMOUNT");

        expect(codeOf(() => WalletLedgerEntry.create({
            id: "l-neg",
            walletId: "w-1",
            transactionId: "tx-1",
            direction: LedgerDirection.Credit,
            money: brl("10.00").negate(),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("90.00"),
        }))).toBe("INVALID_LEDGER_AMOUNT");
    });

    it("rejeita identificadores ausentes ou vazios", () => {
        expect(codeOf(() => WalletLedgerEntry.create({
            id: "",
            walletId: "w-1",
            transactionId: "tx-1",
            direction: LedgerDirection.Debit,
            money: brl("10.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("90.00"),
        }))).toBe("INVALID_ID");

        expect(codeOf(() => WalletLedgerEntry.create({
            id: "l-1",
            walletId: "",
            transactionId: "tx-1",
            direction: LedgerDirection.Debit,
            money: brl("10.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("90.00"),
        }))).toBe("INVALID_ID");

        expect(codeOf(() => WalletLedgerEntry.create({
            id: "l-1",
            walletId: "w-1",
            transactionId: "",
            direction: LedgerDirection.Debit,
            money: brl("10.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("90.00"),
        }))).toBe("INVALID_ID");
    });

    it("rejeita lançamento com moedas conflitantes", () => {
        expect(codeOf(() => WalletLedgerEntry.create({
            id: "l-1",
            walletId: "w-1",
            transactionId: "tx-1",
            direction: LedgerDirection.Debit,
            money: usd("10.00"),
            balanceBefore: brl("100.00"),
            balanceAfter: brl("90.00"),
        }))).toBe("CURRENCY_MISMATCH");
    });

    it("reidrata entrada do ledger sem revalidar regras", () => {
        const createdAt = new Date("2026-03-01T10:00:00.000Z");
        const entry = WalletLedgerEntry.rehydrate({
            id: "l-rehydrated",
            walletId: "w-rehydrated",
            transactionId: "tx-rehydrated",
            direction: LedgerDirection.Credit,
            money: { amount: "100.00", currency: "BRL" },
            balanceBefore: { amount: "200.00", currency: "BRL" },
            balanceAfter: { amount: "300.00", currency: "BRL" },
            createdAt,
        });

        expect(entry.id).toBe("l-rehydrated");
        expect(entry.walletId).toBe("w-rehydrated");
        expect(entry.transactionId).toBe("tx-rehydrated");
        expect(entry.direction).toBe(LedgerDirection.Credit);
        expect(entry.money.toJSON().amount).toBe("100.00");
        expect(entry.balanceBefore.toJSON().amount).toBe("200.00");
        expect(entry.balanceAfter.toJSON().amount).toBe("300.00");
        expect(entry.createdAt.toISOString()).toBe(createdAt.toISOString());
    });
});