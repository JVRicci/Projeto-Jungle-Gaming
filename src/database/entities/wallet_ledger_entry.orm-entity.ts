import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

export const WalletLedgerEntries = defineEntity({
    name: 'WalletLedgerEntriesOrmEntity',
    tableName: 'wallet_ledger_entries',
    properties: {
        id: p.string().primary().length(36),
        walletId: p.string().length(36),
        transactionId: p.string().length(36),
        direction: p.string().length(10),
        amount: p.decimal('string').precision(20).scale(2),
        balanceBefore: p.decimal('string').precision(20).scale(2),
        balanceAfter: p.decimal('string').precision(20).scale(2),
        currency: p.string().length(3),
        createdAt: p.datetime().columnType('timestamptz')
    },
})

export type WalletLedgerEntriesRecord = InferEntity<typeof WalletLedgerEntries>