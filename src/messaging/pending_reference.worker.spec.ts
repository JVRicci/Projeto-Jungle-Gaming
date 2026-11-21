import { describe, expect, it } from "bun:test";
import { pendingReferenceBackoffMs } from "./pending_reference.worker";

describe("pendingReferenceBackoffMs", () => {
    it("dobra a cada tentativa e respeita o teto de 15s", () => {
        expect([0, 1, 2, 3, 4, 5, 10].map((n) => pendingReferenceBackoffMs(n))).toEqual([
            1000, 2000, 4000, 8000, 15000, 15000, 15000,
        ]);
    });
});