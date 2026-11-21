import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
    ChangeMessageVisibilityCommand,
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import type { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../../src/app.module";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process_wager_transaction.use_case";
import { WagerTransactionKind } from "../../src/domain/wager/wager_transaction";
import { OutboxPublisherWorker } from "../../src/messaging/outbox_publisher.worker";
import { createSqsClient } from "../../src/messaging/sqs_client";
import { SqsWagerConsumer } from "../../src/messaging/sqs_wager.consumer";

async function drainQueue(sqs: SQSClient, queueUrl: string): Promise<string[]> {
    const bodies: string[] = [];
    for (let i = 0; i < 10; i++) {
        const res = await sqs.send(
            new ReceiveMessageCommand({
                QueueUrl: queueUrl,
                MaxNumberOfMessages: 10,
                WaitTimeSeconds: 0,
            }),
        );
        const msgs = res.Messages ?? [];
        if (msgs.length === 0) break;
        for (const m of msgs) {
            if (m.Body) bodies.push(m.Body);
            if (m.ReceiptHandle) {
                await sqs.send(
                    new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: m.ReceiptHandle }),
                );
            }
        }
    }
    return bodies;
}

describe("Distributed Resilience: 3+ Instâncias, Crash Pós-Commit/Pré-Ack e /metrics", () => {
    const apps: INestApplication[] = [];
    const urls: string[] = [];
    let orm: MikroORM;
    let sqs: SQSClient;

    const mainQueueUrl = process.env.SQS_WAGER_QUEUE_URL!;
    const dlqUrl = process.env.SQS_WAGER_DLQ_URL!;
    const eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL!;

    beforeAll(async () => {
        process.env.WORKERS_ENABLED = "false";
        sqs = createSqsClient();

        // Sobe 3 instâncias independentes da aplicação (3 servidores HTTP + 3 pools Postgres)
        for (let i = 0; i < 3; i++) {
            const app = await NestFactory.create(AppModule, { logger: false });
            await app.listen(0, "127.0.0.1");
            apps.push(app);
            urls.push(await app.getUrl());
        }

        orm = apps[0]!.get(MikroORM);
        await orm.migrator.up();
    });

    beforeEach(async () => {
        await orm.em
            .fork()
            .execute(
                "TRUNCATE TABLE outbox_messages, inbox_messages, wager_transactions, wallet_ledger_entries, wallets CASCADE",
            );
        await drainQueue(sqs, mainQueueUrl);
        await drainQueue(sqs, dlqUrl);
        await drainQueue(sqs, eventsQueueUrl);
    });

    afterAll(async () => {
        sqs.destroy();
        for (const app of apps) {
            await app.close();
        }
    });

    it("3 instâncias simultâneas processam hot wallet + wallet distinta em paralelo mantendo consistência e expondo /metrics", async () => {
        const playerA = crypto.randomUUID();
        const playerB = crypto.randomUUID();

        const walletA = (await (
            await fetch(`${urls[0]}/wallets`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    playerId: playerA,
                    initialBalance: { amount: "100.00", currency: "BRL" },
                }),
            })
        ).json()) as { id: string };

        const walletB = (await (
            await fetch(`${urls[1]}/wallets`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    playerId: playerB,
                    initialBalance: { amount: "100.00", currency: "BRL" },
                }),
            })
        ).json()) as { id: string };

        // 15 apostas de 10.00 na Wallet A (só cabem 10!) + 6 apostas de 10.00 na Wallet B, distribuídas nas 3 instâncias
        const hotWalletRequests = Array.from({ length: 15 }, (_, i) => {
            const targetUrl = urls[i % 3]!;
            return fetch(`${targetUrl}/wagering/transactions`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": `provider-a:multi-a-${i}`,
                },
                body: JSON.stringify({
                    providerId: "provider-a",
                    externalTransactionId: `multi-a-${i}`,
                    playerId: playerA,
                    walletId: walletA.id,
                    roundId: `round-a-${i}`,
                    gameId: "fortune-chimp",
                    kind: "BET",
                    money: { amount: "10.00", currency: "BRL" },
                }),
            });
        });

        const parallelWalletRequests = Array.from({ length: 6 }, (_, i) => {
            const targetUrl = urls[i % 3]!;
            return fetch(`${targetUrl}/wagering/transactions`, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "idempotency-key": `provider-a:multi-b-${i}`,
                },
                body: JSON.stringify({
                    providerId: "provider-a",
                    externalTransactionId: `multi-b-${i}`,
                    playerId: playerB,
                    walletId: walletB.id,
                    roundId: `round-b-${i}`,
                    gameId: "fortune-chimp",
                    kind: "BET",
                    money: { amount: "10.00", currency: "BRL" },
                }),
            });
        });

        const hotResponses = await Promise.all(hotWalletRequests);
        const parallelResponses = await Promise.all(parallelWalletRequests);

        expect(hotResponses.filter((r) => r.status === 200)).toHaveLength(10);
        expect(hotResponses.filter((r) => r.status === 422)).toHaveLength(5);
        expect(parallelResponses.filter((r) => r.status === 200)).toHaveLength(6);

        // Reconciliação final de ambas as wallets
        const recA = (await (
            await fetch(`${urls[2]}/wallets/${walletA.id}/reconciliation`, { method: "POST" })
        ).json()) as { consistent: boolean; storedBalance: { amount: string } };
        expect(recA.consistent).toBe(true);
        expect(recA.storedBalance.amount).toBe("0.00");

        const recB = (await (
            await fetch(`${urls[0]}/wallets/${walletB.id}/reconciliation`, { method: "POST" })
        ).json()) as { consistent: boolean; storedBalance: { amount: string } };
        expect(recB.consistent).toBe(true);
        expect(recB.storedBalance.amount).toBe("40.00");

        // GET /metrics retorna métricas estruturadas + outboxLag
        const metricsRes = await fetch(`${urls[0]}/metrics`);
        expect(metricsRes.status).toBe(200);
        const metrics = (await metricsRes.json()) as {
            transactionsByStatus: Record<string, number>;
            outboxLag: { pendingCount: number };
            processingLatencyMs: { count: number };
        };
        expect(metrics.processingLatencyMs.count).toBeGreaterThan(0);
        expect(metrics.outboxLag.pendingCount).toBeGreaterThan(0);
    });

    it("crash depois do commit e antes do ack: nova instância assume redelivery sem duplicar débito e publica outbox", async () => {
        const playerId = crypto.randomUUID();
        const wallet = (await (
            await fetch(`${urls[0]}/wallets`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    playerId,
                    initialBalance: { amount: "100.00", currency: "BRL" },
                }),
            })
        ).json()) as { id: string };

        // Drena eventos de abertura
        await apps[0]!.get(OutboxPublisherWorker).publishBatchOnce(20, new Date(Date.now() + 5000));
        await drainQueue(sqs, eventsQueueUrl);

        await sqs.send(
            new SendMessageCommand({
                QueueUrl: mainQueueUrl,
                MessageBody: JSON.stringify({
                    messageId: "msg-crash-1",
                    type: "WagerTransactionRequested",
                    occurredAt: new Date().toISOString(),
                    data: {
                        providerId: "provider-a",
                        externalTransactionId: "bet-crash-1",
                        idempotencyKey: "provider-a:bet-crash-1",
                        playerId,
                        walletId: wallet.id,
                        roundId: "round-crash",
                        gameId: "fortune-chimp",
                        kind: WagerTransactionKind.Bet,
                        money: { amount: "35.00", currency: "BRL" },
                    },
                }),
                MessageGroupId: wallet.id,
                MessageDeduplicationId: `crash-${crypto.randomUUID()}`,
            }),
        );

        // 1. Instância 1: commita no Postgres mas "morre" antes de concluir o DeleteMessage (ack)
        let unackedReceiptHandle: string | undefined;
        const crashingSqs = {
            send: async (cmd: unknown) => {
                if (cmd instanceof DeleteMessageCommand) {
                    unackedReceiptHandle = cmd.input.ReceiptHandle;
                    throw new Error("SIMULATED_CRASH_BEFORE_ACK");
                }
                if (cmd instanceof ChangeMessageVisibilityCommand) {
                    throw new Error("SIMULATED_CRASH_BEFORE_ACK");
                }
                return sqs.send(cmd as ReceiveMessageCommand);
            },
        } as unknown as SQSClient;

        const crashingConsumer = new SqsWagerConsumer(
            crashingSqs,
            apps[0]!.get(ProcessWagerTransactionUseCase),
        );

        await crashingConsumer.pollOnce(0);
        expect(unackedReceiptHandle).toBeDefined();

        // Simula visibilidade expirando imediatamente (mensagem volta para a fila)
        await sqs.send(
            new ChangeMessageVisibilityCommand({
                QueueUrl: mainQueueUrl,
                ReceiptHandle: unackedReceiptHandle!,
                VisibilityTimeout: 0,
            }),
        );

        // 2. Sobe uma nova instância do zero (recuperação pós-reinício) para assumir redelivery e outbox
        const restartedApp = await NestFactory.create(AppModule, { logger: false });
        await restartedApp.init();

        try {
            const recoveredConsumer = restartedApp.get(SqsWagerConsumer);
            const recoveredOutbox = restartedApp.get(OutboxPublisherWorker);

            const consumed = await recoveredConsumer.pollOnce(0);
            expect(consumed).toBe(1);

            const published = await recoveredOutbox.publishBatchOnce(20, new Date(Date.now() + 5000));
            expect(published).toBe(2); // WagerTransactionProcessed + WalletBalanceChanged

            const publishedEvents = (await drainQueue(sqs, eventsQueueUrl)).map(
                (b) => JSON.parse(b) as { eventType: string },
            );
            expect(publishedEvents.map((e) => e.eventType).sort()).toEqual([
                "WagerTransactionProcessed",
                "WalletBalanceChanged",
            ]);
        } finally {
            await restartedApp.close();
        }

        // 3. Reconciliação final: saldo 65.00 (debitou 35.00 exatamente 1 vez!) e ledger 100% consistente
        const rec = (await (
            await fetch(`${urls[1]}/wallets/${wallet.id}/reconciliation`, { method: "POST" })
        ).json()) as {
            consistent: boolean;
            storedBalance: { amount: string };
            checkedEntries: number;
        };
        expect(rec.consistent).toBe(true);
        expect(rec.storedBalance.amount).toBe("65.00");
        expect(rec.checkedEntries).toBe(2); // 1 OPENING + 1 BET
    });
});