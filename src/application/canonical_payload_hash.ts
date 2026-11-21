import { createHash } from "node:crypto";
import type { MoneyProps } from "../domain/money/money";
import type { WagerTransactionKind } from "../domain/wager/wager_transaction";

export interface WagewrBusinessPayload {
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string
}

function canonicalize(value: unknown): unknown{
    if (Array.isArray(value)){
        return value.map(canonicalize)
    }

    if (value !== null && typeof value === "object") {
        const sorted: Record<string, unknown> = {}
        for (const key of Object.keys(value as Record<string, unknown>).sort()){
            const v = (value as Record<string, unknown>)[key];

            if(v !== undefined) {
                sorted[key] = canonicalize(v)
            }
        }
        return sorted
    }
    return value;
}

export function canonicalPayloadHash(payload: unknown): string {
    const json = JSON.stringify(canonicalize(payload))
    return createHash("sha256").update(json, "utf8").digest("hex")
}

export function hashWagerPayload(input: WagewrBusinessPayload): string {
    return canonicalPayloadHash({
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money: {
            amount: input.money.amount,
            currency: input.money.currency,
        },
        referenceExternalTransactionId: input.referenceExternalTransactionId,
    });
}