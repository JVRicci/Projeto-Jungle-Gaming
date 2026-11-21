import { describe, expect, it } from "bun:test";
import { Money } from "../domain/money/money";
import {
    FailureCode,
    WagerTransaction,
    WagerTransactionKind,
} from "../domain/wager/wager_transaction";
import { Wallet } from "../domain/wallet/wallet";
import {
    isReferenceUnavailable,
    validateAgainstWallet,
    validateReversalReference,
    validateWinReference,
} from "./wager_rules";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const usd = (amount: string) => Money.from({ amount, currency: "USD" });

function makeWallet(overrides?: Partial<{ id: string; playerId: string; amount: string }>) {
    return Wallet.open({
        id: overrides?.id ?? "w-1",
        playerId: overrides?.playerId ?? "p-1",
        initialBalance: brl(overrides?.amount ?? "100.00"),
    });
}

function makeTx(
    overrides?: Partial<{
        id: string;
        providerId: string;
        externalTransactionId: string;
        playerId: string;
        walletId: string;
        roundId: string;
        kind: WagerTransactionKind;
        money: Money;
        referenceExternalTransactionId: string;
    }>,
) {
    const kind = overrides?.kind ?? WagerTransactionKind.Bet;
    const needsRef =
        kind === WagerTransactionKind.Refund || kind === WagerTransactionKind.Rollback;

    return WagerTransaction.create({
        id: overrides?.id ?? crypto.randomUUID(),
        providerId: overrides?.providerId ?? "provider-a",
        externalTransactionId: overrides?.externalTransactionId ?? "ext-1",
        idempotencyKey: `key-${crypto.randomUUID()}`,
        payloadHash: "a".repeat(64),
        walletId: overrides?.walletId ?? "w-1",
        playerId: overrides?.playerId ?? "p-1",
        roundId: overrides?.roundId ?? "round-1",
        gameId: "fortune-chimp",
        kind,
        money: overrides?.money ?? brl("25.00"),
        referenceExternalTransactionId:
            overrides?.referenceExternalTransactionId ?? (needsRef ? "ext-bet-1" : undefined),
    });
}

describe("wager_rules", () => {
    describe("isReferenceUnavailable", () => {
        it("retorna true para undefined, PENDING e PENDING_REFERENCE", () => {
            expect(isReferenceUnavailable(undefined)).toBe(true);

            const pending = makeTx();
            expect(isReferenceUnavailable(pending)).toBe(true);

            const pendingRef = makeTx({ kind: WagerTransactionKind.Refund });
            pendingRef.markPendingReference();
            expect(isReferenceUnavailable(pendingRef)).toBe(true);
        });

        it("retorna false para PROCESSED e REJECTED", () => {
            const processed = makeTx();
            processed.markProcessed(undefined, new Date());
            expect(isReferenceUnavailable(processed)).toBe(false);

            const rejected = makeTx();
            rejected.reject(FailureCode.InsufficientFunds);
            expect(isReferenceUnavailable(rejected)).toBe(false);
        });
    });

    describe("validateAgainstWallet", () => {
        it("aceita BET válida e LOSS com valor 0.00", () => {
            const wallet = makeWallet();
            expect(validateAgainstWallet(wallet, makeTx({ kind: WagerTransactionKind.Bet }))).toBeNull();
            expect(
                validateAgainstWallet(
                    wallet,
                    makeTx({ kind: WagerTransactionKind.Loss, money: brl("0.00") }),
                ),
            ).toBeNull();
        });

        it("rejeita playerId divergente, moeda divergente e valor 0.00 em BET", () => {
            const wallet = makeWallet();

            expect(validateAgainstWallet(wallet, makeTx({ playerId: "other-player" }))).toBe(
                FailureCode.ReferenceMismatch,
            );
            expect(validateAgainstWallet(wallet, makeTx({ money: usd("25.00") }))).toBe(
                FailureCode.CurrencyMismatch,
            );
            expect(
                validateAgainstWallet(
                    wallet,
                    makeTx({ kind: WagerTransactionKind.Bet, money: brl("0.00") }),
                ),
            ).toBe(FailureCode.InvalidAmount);
        });
    });

    describe("validateReversalReference", () => {
        it("aceita REFUND de BET e ROLLBACK de BET/WIN/REFUND processadas", () => {
            const bet = makeTx({ kind: WagerTransactionKind.Bet });
            bet.markProcessed(undefined, new Date());

            const win = makeTx({ kind: WagerTransactionKind.Win });
            win.markProcessed(undefined, new Date());

            const refundRef = makeTx({ kind: WagerTransactionKind.Refund });
            refundRef.markProcessed(bet.id, new Date());

            const refund = makeTx({ kind: WagerTransactionKind.Refund });
            const rollback = makeTx({ kind: WagerTransactionKind.Rollback });

            expect(validateReversalReference(refund, bet, false)).toBeNull();
            expect(validateReversalReference(rollback, bet, false)).toBeNull();
            expect(validateReversalReference(rollback, win, false)).toBeNull();
            expect(validateReversalReference(rollback, refundRef, false)).toBeNull();
        });

        it("rejeita referência não PROCESSED, tipo incompatível, escopo/valor divergente e já revertida", () => {
            const rejectedBet = makeTx({ kind: WagerTransactionKind.Bet });
            rejectedBet.reject(FailureCode.InsufficientFunds);

            const processedWin = makeTx({ kind: WagerTransactionKind.Win });
            processedWin.markProcessed(undefined, new Date());

            const processedLoss = makeTx({ kind: WagerTransactionKind.Loss });
            processedLoss.markProcessed(undefined, new Date());

            const processedBet = makeTx({ kind: WagerTransactionKind.Bet, roundId: "round-1" });
            processedBet.markProcessed(undefined, new Date());

            const refund = makeTx({ kind: WagerTransactionKind.Refund });
            const rollback = makeTx({ kind: WagerTransactionKind.Rollback });

            // Referência REJECTED
            expect(validateReversalReference(refund, rejectedBet, false)).toBe(
                FailureCode.InvalidReferenceKind,
            );
            // REFUND apontando para WIN
            expect(validateReversalReference(refund, processedWin, false)).toBe(
                FailureCode.InvalidReferenceKind,
            );
            // ROLLBACK apontando para LOSS
            expect(validateReversalReference(rollback, processedLoss, false)).toBe(
                FailureCode.InvalidReferenceKind,
            );
            // Rodada divergente
            expect(
                validateReversalReference(
                    makeTx({ kind: WagerTransactionKind.Refund, roundId: "round-other" }),
                    processedBet,
                    false,
                ),
            ).toBe(FailureCode.ReferenceMismatch);
            // Valor divergente (reversão parcial fora de escopo)
            expect(
                validateReversalReference(
                    makeTx({ kind: WagerTransactionKind.Refund, money: brl("10.00") }),
                    processedBet,
                    false,
                ),
            ).toBe(FailureCode.InvalidAmount);
            // Já revertida
            expect(validateReversalReference(refund, processedBet, true)).toBe(
                FailureCode.ReferenceAlreadySettled,
            );
        });
    });

    describe("validateWinReference", () => {
        it("aceita referência no mesmo escopo e rejeita rodada/player divergente", () => {
            const bet = makeTx({ kind: WagerTransactionKind.Bet, roundId: "round-1" });
            bet.markProcessed(undefined, new Date());
            expect(
                validateWinReference(
                    makeTx({ kind: WagerTransactionKind.Win, roundId: "round-1" }),
                    bet,
                ),
            ).toBeNull();
            expect(
                validateWinReference(
                    makeTx({ kind: WagerTransactionKind.Win, roundId: "round-2" }),
                    bet,
                ),
            ).toBe(FailureCode.ReferenceMismatch);
        });
    });
});