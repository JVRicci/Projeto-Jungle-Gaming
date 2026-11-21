import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";

describe("HTTP API Integration (NestJS + PostgreSQL + LocalStack)", () => {
    let app: INestApplication;
    let orm: MikroORM;
    let baseUrl: string;

    beforeAll(async () => {
        process.env.WORKERS_ENABLED = "false";
        app = await NestFactory.create(AppModule, { logger: false });
        await app.listen(0, "127.0.0.1");
        baseUrl = await app.getUrl();
        orm = app.get(MikroORM);
        await orm.migrator.up();
    });

    beforeEach(async () => {
        await orm.em
            .fork()
            .execute(
                "TRUNCATE TABLE outbox_messages, inbox_messages, wager_transactions, wallet_ledger_entries, wallets CASCADE",
            );
    });

    afterAll(async () => {
        await app.close();
    });

    it("GET /health/live e GET /health/ready retornam 200 com Postgres e SQS saudáveis", async () => {
        const live = await fetch(`${baseUrl}/health/live`);
        expect(live.status).toBe(200);

        const ready = await fetch(`${baseUrl}/health/ready`);
        expect(ready.status).toBe(200);
        const body = (await ready.json()) as { status: string; checks: { postgres: string; sqs: string } };
        expect(body.status).toBe("ready");
        expect(body.checks).toEqual({ postgres: "ok", sqs: "ok" });
    });

    it("cobre ciclo completo HTTP: criar wallet, consultar, apostar, replay, conflito, rejeição, pendente, ledger e reconciliação", async () => {
        const playerId = crypto.randomUUID();

        // 1. POST /wallets → 201 (e duplicada → 409)
        const createRes = await fetch(`${baseUrl}/wallets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                playerId,
                initialBalance: { amount: "100.00", currency: "BRL" },
            }),
        });
        expect(createRes.status).toBe(201);
        const wallet = (await createRes.json()) as { id: string; balance: { amount: string }; version: number };
        expect(wallet.balance.amount).toBe("100.00");
        expect(wallet.version).toBe(1);

        const dupWallet = await fetch(`${baseUrl}/wallets`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                playerId,
                initialBalance: { amount: "50.00", currency: "BRL" },
            }),
        });
        expect(dupWallet.status).toBe(409);

        // 2. GET /wallets/:walletId → 200 (e inexistente → 404)
        expect((await fetch(`${baseUrl}/wallets/${wallet.id}`)).status).toBe(200);
        expect((await fetch(`${baseUrl}/wallets/${crypto.randomUUID()}`)).status).toBe(404);

        const betPayload = {
            providerId: "provider-a",
            externalTransactionId: "tx-http-1",
            playerId,
            walletId: wallet.id,
            roundId: "round-1",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "25.00", currency: "BRL" },
        };

        // 3. Sem Idempotency-Key → 400
        const noKeyRes = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(betPayload),
        });
        expect(noKeyRes.status).toBe(400);

        // 4. BET válido → 200 (idempotentReplay: false)
        const betRes = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "provider-a:tx-http-1",
            },
            body: JSON.stringify(betPayload),
        });
        expect(betRes.status).toBe(200);
        const betBody = (await betRes.json()) as {
            transactionId: string;
            status: string;
            balance: { amount: string };
            idempotentReplay: boolean;
        };
        expect(betBody.status).toBe("PROCESSED");
        expect(betBody.balance.amount).toBe("75.00");
        expect(betBody.idempotentReplay).toBe(false);

        // 5. Replay idêntico → 200 (idempotentReplay: true)
        const replayRes = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "provider-a:tx-http-1",
            },
            body: JSON.stringify(betPayload),
        });
        expect(replayRes.status).toBe(200);
        expect(((await replayRes.json()) as { idempotentReplay: boolean }).idempotentReplay).toBe(true);

        // 6. Mesma key com payload diferente → 409
        const conflictRes = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "provider-a:tx-http-1",
            },
            body: JSON.stringify({ ...betPayload, money: { amount: "99.00", currency: "BRL" } }),
        });
        expect(conflictRes.status).toBe(409);

        // 7. Saldo insuficiente → 422
        const rejectedRes = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "provider-a:tx-too-big",
            },
            body: JSON.stringify({
                ...betPayload,
                externalTransactionId: "tx-too-big",
                money: { amount: "500.00", currency: "BRL" },
            }),
        });
        expect(rejectedRes.status).toBe(422);

        // 8. REFUND sem referência → 202 (PENDING_REFERENCE)
        const pendingRes = await fetch(`${baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "idempotency-key": "provider-a:tx-ref-orphan",
            },
            body: JSON.stringify({
                ...betPayload,
                externalTransactionId: "tx-ref-orphan",
                kind: "REFUND",
                referenceExternalTransactionId: "bet-missing",
            }),
        });
        expect(pendingRes.status).toBe(202);

        // 9. Consultas de transação e ledger paginado
        expect((await fetch(`${baseUrl}/wagering/transactions/${betBody.transactionId}`)).status).toBe(200);
        expect(
            (await fetch(`${baseUrl}/providers/provider-a/wagering/transactions/tx-http-1`)).status,
        ).toBe(200);

        const ledger1 = (await (
            await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1`)
        ).json()) as { items: unknown[]; nextCursor: string | null };
        expect(ledger1.items).toHaveLength(1);
        expect(ledger1.nextCursor).not.toBeNull();

        const ledger2 = (await (
            await fetch(`${baseUrl}/wallets/${wallet.id}/ledger?limit=1&cursor=${ledger1.nextCursor}`)
        ).json()) as { items: unknown[]; nextCursor: string | null };
        expect(ledger2.items).toHaveLength(1);
        expect(ledger2.nextCursor).toBeNull();

        // 10. Reconciliação → 200 e consistent: true
        const recRes = await fetch(`${baseUrl}/wallets/${wallet.id}/reconciliation`, {
            method: "POST",
        });
        expect(recRes.status).toBe(200);
        const recBody = (await recRes.json()) as { consistent: boolean; storedBalance: { amount: string } };
        expect(recBody.consistent).toBe(true);
        expect(recBody.storedBalance.amount).toBe("75.00");
    });
});