import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

export const WagerTransactionOrmEntity = defineEntity({
    name: 'WagerTransactionOrmEntity',
    tableName: 'wager_transactions',
    properties: {
        id: p.string().primary().length(36),
        providerId: p.string().length(100),
        externalTransactionId: p.string().length(100),
        idempotencyKey: p.string().length(255),
        payloadHash: p.string().length(64),
        walletId: p.string().length(36),
        playerId: p.string().length(36),
        roundId: p.string().length(100),
        gameId: p.string().length(100),
        kind: p.string().length(20),
        amount: p.decimal('string').precision(20).scale(2),
        observedBalance: p.decimal('string').precision(20).scale(2).nullable(),
        currency: p.string().length(3),
        status: p.string().length(30),
        referenceExternalTransactionId: p.string().length(100).nullable(),
        referenceTransactionId: p.string().length(36).nullable(),
        failureCode: p.string().length(50).nullable(),
        referenceAttempts: p.integer().default(0),
        referenceNextAttemptAt: p.datetime().columnType('timestamptz').nullable(),
        createdAt: p.datetime().columnType('timestamptz'),
        processedAt: p.datetime().columnType('timestamptz').nullable(),
    },
});

export type WagerTransactionRecord = InferEntity<typeof WagerTransactionOrmEntity>;