import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { CreateWalletUseCase } from "../../src/application/use-cases/create_wallet.use_case";
import { ProcessWagerTransactionUseCase } from "../../src/application/use-cases/process_wager_transaction.use_case";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile_wallet.use_case";
import { MikroOrmUnitOfWork } from "../../src/database/repositories/unit_of_work";
import {
    FailureCode,
    WagerTransactionKind,
    WagerTransactionStatus,
} from "../../src/domain/wager/wager_transaction";
import { OutboxPublisherWorker } from "../../src/messaging/outbox_publisher.worker";
import { PendingReferenceWorker } from "../../src/messaging/pending_reference.worker";
import { createSqsClient } from "../../src/messaging/sqs_client";
import { SqsWagerConsumer } from "../../src/messaging/sqs_wager.consumer";

async function drainQueue(sqs: SQSClient, queueUrl: string): Promise<string[]> {
    const bodies: string[] = [];
    for (let i = 0; i < 20; i++) {
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

async function waitForHealth(port: number, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/health/live`);
            if (res.status === 200) return;
        } catch {
            // ainda subindo
        }
        await Bun.sleep(200);
    }
    throw new Error(`Instância na porta ${port} não respondeu /health/live em ${timeoutMs}ms`);
}

describe("Concurrency & P0 Verification Suite (PostgreSQL + LocalStack)", () => {
    let orm: MikroORM;
    let uow: MikroOrmUnitOfWork;
    let sqs: SQSClient;
    let createWallet: CreateWalletUseCase;
    let processWager: ProcessWagerTransactionUseCase;
    let reconcileWallet: ReconcileWalletUseCase;
    let consumer: SqsWagerConsumer;
    let pendingRefWorker: PendingReferenceWorker;

    const mainQueueUrl = process.env.SQS_WAGER_QUEUE_URL!;
    const dlqUrl = process.env.SQS_WAGER_DLQ_URL!;
    const eventsQueueUrl = process.env.SQS_EVENTS_QUEUE_URL!;

    beforeAll(async () => {
        orm = await MikroORM.init(config);
        await orm.migrator.up();
        uow = new MikroOrmUnitOfWork(orm.em);
        sqs = createSqsClient();
        createWallet = new CreateWalletUseCase(uow);
        processWager = new ProcessWagerTransactionUseCase(uow);
        reconcileWallet = new ReconcileWalletUseCase(uow);
        consumer = new SqsWagerConsumer(sqs, processWager);
        pendingRefWorker = new PendingReferenceWorker(uow);
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
        await orm.close(true);
    });

    it("P0: REFUND seguido de ROLLBACK da mesma BET rejeita o segundo e preserva saldo", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "100.00", currency: "BRL" },
        });
        const base = { providerId: "provider-a", playerId, walletId: wallet.id, roundId: "r1", gameId: "g1" };

        await processWager.execute({
            ...base,
            idempotencyKey: "provider-a:b1",
            externalTransactionId: "b1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "40.00", currency: "BRL" },
        });

        const refund = await processWager.execute({
            ...base,
            idempotencyKey: "provider-a:rf1",
            externalTransactionId: "rf1",
            kind: WagerTransactionKind.Refund,
            money: { amount: "40.00", currency: "BRL" },
            referenceExternalTransactionId: "b1",
        });

        const rollback = await processWager.execute({
            ...base,
            idempotencyKey: "provider-a:rb1",
            externalTransactionId: "rb1",
            kind: WagerTransactionKind.Rollback,
            money: { amount: "40.00", currency: "BRL" },
            referenceExternalTransactionId: "b1",
        });

        expect(refund.status).toBe(WagerTransactionStatus.Processed);
        expect(rollback.status).toBe(WagerTransactionStatus.Rejected);
        expect(rollback.failureCode).toBe(FailureCode.ReferenceAlreadySettled);

        const report = await reconcileWallet.execute(wallet.id);
        expect(report.consistent).toBe(true);
        expect(report.storedBalance.amount).toBe("100.00");
    });

    it("P0: Inbox rejeita mesmo messageId com payload diferente (IDEMPOTENCY_CONFLICT) e faz replay se idêntico", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "100.00", currency: "BRL" },
        });
        const input = {
            idempotencyKey: "provider-a:ib1",
            providerId: "provider-a",
            externalTransactionId: "ib1",
            playerId,
            walletId: wallet.id,
            roundId: "r1",
            gameId: "g1",
            kind: WagerTransactionKind.Bet,
            money: { amount: "10.00", currency: "BRL" },
            inbox: { consumerName: "c", messageId: "m-1" },
        };

        const first = await processWager.execute(input);
        const second = await processWager.execute(input);
        expect(second.idempotentReplay).toBe(true);
        expect(second.transactionId).toBe(first.transactionId);

        const conflicting = {
            ...input,
            idempotencyKey: "provider-a:ib2",
            externalTransactionId: "ib2",
        };
        await expect(processWager.execute(conflicting)).rejects.toMatchObject({
            code: "IDEMPOTENCY_CONFLICT",
        });
    });

    it("20 wallets distintas em paralelo (100 apostas simultâneas): todas consistentes", async () => {
        const wallets = await Promise.all(
            Array.from({ length: 20 }, () =>
                createWallet.execute({
                    playerId: crypto.randomUUID(),
                    initialBalance: { amount: "100.00", currency: "BRL" },
                }),
            ),
        );

        const jobs = wallets.flatMap((w, wi) =>
            Array.from({ length: 5 }, (_, i) =>
                processWager.execute({
                    idempotencyKey: `p:w${wi}-${i}`,
                    providerId: "p",
                    externalTransactionId: `w${wi}-${i}`,
                    playerId: w.playerId,
                    walletId: w.id,
                    roundId: `r${i}`,
                    gameId: "g",
                    kind: WagerTransactionKind.Bet,
                    money: { amount: "10.00", currency: "BRL" },
                }),
            ),
        );

        const results = await Promise.all(jobs);
        expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);

        for (const w of wallets) {
            const rep = await reconcileWallet.execute(w.id);
            expect(rep.consistent).toBe(true);
            expect(rep.storedBalance.amount).toBe("50.00");
        }
    });

    it("dois publishers concorrentes sobre a mesma outbox publicam cada evento uma única vez", async () => {
        for (let i = 0; i < 10; i++) {
            await createWallet.execute({
                playerId: crypto.randomUUID(),
                initialBalance: { amount: "10.00", currency: "BRL" },
            });
        } // 20 eventos na outbox

        const pubA = new OutboxPublisherWorker(uow, sqs);
        const pubB = new OutboxPublisherWorker(uow, sqs);
        const future = new Date(Date.now() + 5000);

        let total = 0;
        for (let round = 0; round < 6; round++) {
            const [x, y] = await Promise.all([
                pubA.publishBatchOnce(4, future),
                pubB.publishBatchOnce(4, future),
            ]);
            total += x + y;
        }

        expect(total).toBe(20);
        const ids = (await drainQueue(sqs, eventsQueueUrl)).map(
            (m) => (JSON.parse(m) as { eventId: string }).eventId,
        );
        expect(new Set(ids).size).toBe(20);
    });

    it("ROLLBACK via SQS antes do WIN agenda backoff e resolve quando o WIN chega", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "100.00", currency: "BRL" },
        });

        // 1. ROLLBACK chega antes do WIN
        await sqs.send(
            new SendMessageCommand({
                QueueUrl: mainQueueUrl,
                MessageGroupId: wallet.id,
                MessageDeduplicationId: crypto.randomUUID(),
                MessageBody: JSON.stringify({
                    messageId: "msg-rb-early",
                    data: {
                        providerId: "provider-a",
                        externalTransactionId: "rb-win-late",
                        idempotencyKey: "provider-a:rb-win-late",
                        playerId,
                        walletId: wallet.id,
                        roundId: "round-sq",
                        gameId: "g1",
                        kind: WagerTransactionKind.Rollback,
                        money: { amount: "50.00", currency: "BRL" },
                        referenceExternalTransactionId: "win-late",
                    },
                }),
            }),
        );
        await consumer.pollOnce(0);

        // 2. Worker roda ainda sem o WIN → agenda retry exponencial (attempts = 1)
        expect(await pendingRefWorker.processBatchOnce(10, 60_000)).toBe(0);
        const rows = await orm.em
            .fork()
            .execute<{ reference_attempts: number }[]>(
                "SELECT reference_attempts FROM wager_transactions WHERE external_transaction_id = ?",
                ["rb-win-late"],
            );
        expect(rows[0]?.reference_attempts).toBe(1);

        // 3. WIN chega depois (saldo vai de 100 para 150)
        await sqs.send(
            new SendMessageCommand({
                QueueUrl: mainQueueUrl,
                MessageGroupId: wallet.id,
                MessageDeduplicationId: crypto.randomUUID(),
                MessageBody: JSON.stringify({
                    messageId: "msg-win-late",
                    data: {
                        providerId: "provider-a",
                        externalTransactionId: "win-late",
                        idempotencyKey: "provider-a:win-late",
                        playerId,
                        walletId: wallet.id,
                        roundId: "round-sq",
                        gameId: "g1",
                        kind: WagerTransactionKind.Win,
                        money: { amount: "50.00", currency: "BRL" },
                    },
                }),
            }),
        );
        await consumer.pollOnce(0);

        // 4. Worker reprocessa após o backoff → ROLLBACK debita 50 e volta saldo para 100
        expect(await pendingRefWorker.processBatchOnce(10, 60_000, new Date(Date.now() + 5000))).toBe(1);

        const report = await reconcileWallet.execute(wallet.id);
        expect(report.consistent).toBe(true);
        expect(report.storedBalance.amount).toBe("100.00");
    });

    it("3 processos reais simultâneos (Bun.spawn) disputando a mesma wallet mantêm consistência", async () => {
        const ports = [3101, 3102, 3103];
        const procs = ports.map((port) =>
            Bun.spawn([process.execPath, "run", "src/main.ts"], {
                env: { ...process.env, PORT: String(port), WORKERS_ENABLED: "false" },
                stdout: "ignore",
                stderr: "ignore",
            }),
        );

        try {
            await Promise.all(ports.map((p) => waitForHealth(p)));

            const playerId = crypto.randomUUID();
            const wallet = (await (
                await fetch(`http://127.0.0.1:${ports[0]}/wallets`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({
                        playerId,
                        initialBalance: { amount: "100.00", currency: "BRL" },
                    }),
                })
            ).json()) as { id: string };

            const responses = await Promise.all(
                Array.from({ length: 30 }, (_, i) => {
                    const port = ports[i % 3]!;
                    return fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            "idempotency-key": `provider-a:proc-${i}`,
                        },
                        body: JSON.stringify({
                            providerId: "provider-a",
                            externalTransactionId: `proc-${i}`,
                            playerId,
                            walletId: wallet.id,
                            roundId: `r-${i}`,
                            gameId: "g1",
                            kind: "BET",
                            money: { amount: "10.00", currency: "BRL" },
                        }),
                    });
                }),
            );

            expect(responses.filter((r) => r.status === 200)).toHaveLength(10);
            expect(responses.filter((r) => r.status === 422)).toHaveLength(20);

            const rec = (await (
                await fetch(`http://127.0.0.1:${ports[2]}/wallets/${wallet.id}/reconciliation`, {
                    method: "POST",
                })
            ).json()) as { consistent: boolean; storedBalance: { amount: string } };

            expect(rec.consistent).toBe(true);
            expect(rec.storedBalance.amount).toBe("0.00");
        } finally {
            for (const proc of procs) {
                proc.kill();
                await proc.exited;
            }
        }
    }, 45_000);
});