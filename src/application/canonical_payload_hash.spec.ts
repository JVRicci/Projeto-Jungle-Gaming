import { describe, expect, it } from "bun:test";
import { WagerTransactionKind } from "../domain/wager/wager_transaction";
import { canonicalPayloadHash, hashWagerPayload } from "./canonical_payload_hash";

describe("canonicalPayloadHash / hashWagerPayload", () => {
    it("gera o mesmo SHA-256 independente da ordem das chaves (incluindo objetos aninhados)", () => {
        const h1 = canonicalPayloadHash({ b: 1, a: { y: "2", x: "1" } });
        const h2 = canonicalPayloadHash({ a: { x: "1", y: "2" }, b: 1 });

        expect(h1).toBe(h2);
        expect(h1).toHaveLength(64);
    });

    it("ignora propriedades com valor undefined", () => {
        const h1 = canonicalPayloadHash({ a: "1", extra: undefined });
        const h2 = canonicalPayloadHash({ a: "1" });

        expect(h1).toBe(h2);
    });

    it("ignora campos extras de transporte/metadados no hashWagerPayload", () => {
        const base = {
            providerId: "provider-a",
            externalTransactionId: "tx-1",
            playerId: "player-1",
            walletId: "wallet-1",
            roundId: "round-1",
            gameId: "game-1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "25.00", currency: "BRL" },
        };

        const h1 = hashWagerPayload(base);
        const h2 = hashWagerPayload({
            ...base,
            correlationId: "corr-123",
            idempotencyKey: "other-key",
        } as typeof base);

        expect(h1).toBe(h2);
    });

    it("detecta divergência quando qualquer campo de negócio muda", () => {
        const base = {
            providerId: "provider-a",
            externalTransactionId: "tx-1",
            playerId: "player-1",
            walletId: "wallet-1",
            roundId: "round-1",
            gameId: "game-1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "25.00", currency: "BRL" },
        };

        const h1 = hashWagerPayload(base);
        const h2 = hashWagerPayload({
            ...base,
            money: { amount: "30.00", currency: "BRL" },
        });

        expect(h1).not.toBe(h2);
    });
});