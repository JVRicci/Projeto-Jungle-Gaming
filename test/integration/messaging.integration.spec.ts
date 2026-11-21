import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import {
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
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
import config from "../../mikro-orm.config";

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

describe("Messaging & Workers Integration (PostgreSQL + LocalStack SQS)", () => {
    let orm: MikroORM;
    let uow: MikroOrmUnitOfWork;
    let sqs: SQSClient;
    let createWallet: CreateWalletUseCase;
    let processWager: ProcessWagerTransactionUseCase;
    let reconcileWallet: ReconcileWalletUseCase;
    let consumer: SqsWagerConsumer;
    let outboxWorker: OutboxPublisherWorker;
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
        outboxWorker = new OutboxPublisherWorker(uow, sqs);
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

    it("consome aposta do SQS, deduplica redelivery via Inbox e publica eventos na Outbox → wager-events.fifo", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "200.00", currency: "BRL" },
        });
        // Limpa eventos de abertura para focar na aposta
        await outboxWorker.publishBatchOnce(20, new Date(Date.now() + 5000));
        await drainQueue(sqs, eventsQueueUrl);

        const messageBody = JSON.stringify({
            messageId: "msg-sqs-1",
            type: "WagerTransactionRequested",
            occurredAt: new Date().toISOString(),
            data: {
                providerId: "provider-a",
                externalTransactionId: "sqs-bet-1",
                idempotencyKey: "provider-a:sqs-bet-1",
                playerId,
                walletId: wallet.id,
                roundId: "round-sqs",
                gameId: "fortune-chimp",
                kind: WagerTransactionKind.Bet,
                money: { amount: "40.00", currency: "BRL" },
            },
        });

        // Envia a mesma mensagem 2 vezes (simulando redelivery com deduplicação distinta no broker)
        await sqs.send(
            new SendMessageCommand({
                QueueUrl: mainQueueUrl,
                MessageBody: messageBody,
                MessageGroupId: wallet.id,
                MessageDeduplicationId: `dedup-1-${crypto.randomUUID()}`,
            }),
        );
        await sqs.send(
            new SendMessageCommand({
                QueueUrl: mainQueueUrl,
                MessageBody: messageBody,
                MessageGroupId: wallet.id,
                MessageDeduplicationId: `dedup-2-${crypto.randomUUID()}`,
            }),
        );

        // Consome todas as entregas
        await consumer.pollOnce(0);
        await consumer.pollOnce(0);

        const report = await reconcileWallet.execute(wallet.id);
        expect(report.consistent).toBe(true);
        expect(report.storedBalance.amount).toBe("160.00"); // debitou apenas 1 vez!

        // Outbox Publisher publica na wager-events.fifo
        const published = await outboxWorker.publishBatchOnce(20, new Date(Date.now() + 5000));
        expect(published).toBe(2); // WagerTransactionProcessed + WalletBalanceChanged

        const events = (await drainQueue(sqs, eventsQueueUrl)).map(
            (b) => JSON.parse(b) as { eventType: string },
        );
        expect(events.map((e) => e.eventType).sort()).toEqual([
            "WagerTransactionProcessed",
            "WalletBalanceChanged",
        ]);
    });

    it("envia mensagem corrompida (erro permanente) para a DLQ e remove da fila principal", async () => {
        await sqs.send(
            new SendMessageCommand({
                QueueUrl: mainQueueUrl,
                MessageBody: "{json-quebrado",
                MessageGroupId: "bad-group",
                MessageDeduplicationId: `bad-${crypto.randomUUID()}`,
            }),
        );

        await consumer.pollOnce(0);

        const dlqMessages = await drainQueue(sqs, dlqUrl);
        expect(dlqMessages).toHaveLength(1);
        expect(JSON.parse(dlqMessages[0]!).reason).toBe("INVALID_JSON");
    });

    it("PendingReferenceWorker resolve REFUND quando a BET chega e expira para REJECTED após TTL", async () => {
        const playerId = crypto.randomUUID();
        const wallet = await createWallet.execute({
            playerId,
            initialBalance: { amount: "100.00", currency: "BRL" },
        });

        // 1. REFUND chega antes da BET → PENDING_REFERENCE
        const pendingRefund = await processWager.execute({
            idempotencyKey: "provider-a:early-refund",
            providerId: "provider-a",
            externalTransactionId: "early-refund",
            playerId,
            walletId: wallet.id,
            roundId: "round-ooo",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Refund,
            money: { amount: "30.00", currency: "BRL" },
            referenceExternalTransactionId: "late-bet",
        });
        expect(pendingRefund.status).toBe(WagerTransactionStatus.PendingReference);

        // 2. BET chega depois (saldo cai de 100 para 70)
        await processWager.execute({
            idempotencyKey: "provider-a:late-bet",
            providerId: "provider-a",
            externalTransactionId: "late-bet",
            playerId,
            walletId: wallet.id,
            roundId: "round-ooo",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Bet,
            money: { amount: "30.00", currency: "BRL" },
        });

        // 3. Worker reprocessa → REFUND vira PROCESSED e devolve saldo para 100
        const resolvedCount = await pendingRefWorker.processBatchOnce(10, 60_000);
        expect(resolvedCount).toBe(1);

        const report = await reconcileWallet.execute(wallet.id);
        expect(report.consistent).toBe(true);
        expect(report.storedBalance.amount).toBe("100.00");

        // 4. Outro REFUND cuja referência nunca chega expira após TTL → REJECTED (REFERENCE_TTL_EXPIRED)
        const orphan = await processWager.execute({
            idempotencyKey: "provider-a:never-arrives",
            providerId: "provider-a",
            externalTransactionId: "never-arrives",
            playerId,
            walletId: wallet.id,
            roundId: "round-ttl",
            gameId: "fortune-chimp",
            kind: WagerTransactionKind.Refund,
            money: { amount: "10.00", currency: "BRL" },
            referenceExternalTransactionId: "ghost-bet",
        });

        const expiredCount = await pendingRefWorker.processBatchOnce(
            10,
            1000,
            new Date(Date.now() + 10_000),
        );
        expect(expiredCount).toBe(1);

        await uow.run(async ({ wagerTransactions }) => {
            const stored = await wagerTransactions.findById(orphan.transactionId);
            expect(stored?.transaction.status).toBe(WagerTransactionStatus.Rejected);
            expect(stored?.transaction.failureCode).toBe(FailureCode.ReferenceTtlExpired);
        });
    });
});