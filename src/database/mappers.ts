import { InboxMessage } from "../domain/messages/inbox";
import { OutboxMessage } from "../domain/messages/outbox";
import {
    WagerTransaction,
    type FailureCode,
    type WagerTransactionKind,
    type WagerTransactionStatus,
} from "../domain/wager/wager_transaction";
import { Wallet } from "../domain/wallet/wallet";
import { WalletLedgerEntry, type LedgerDirection } from "../domain/wallet/wallet_ledger_entry";
import type { StoredWagerTransaction } from "../ports/wager_transaction.repository.port";
import type {
    InboxMessageRecord,
    OutboxMessageRecord,
    WagerTransactionRecord,
    WalletLedgerEntriesRecord,
    WalletRecord,
} from "./entities";

export const WalletMapper = {
    toDomain(record: WalletRecord): Wallet {
        return Wallet.rehydrate({
            id: record.id,
            playerId: record.playerId,
            currency: record.currency,
            balance: { amount: record.balance, currency: record.currency },
            version: record.version,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
        });
    },

    toPersistence(wallet: Wallet): WalletRecord {
        return {
            id: wallet.id,
            playerId: wallet.playerId,
            currency: wallet.currency,
            balance: wallet.balance.toJSON().amount,
            version: wallet.version,
            createdAt: wallet.createdAt,
            updatedAt: wallet.updatedAt,
        };
    },
};

export const WalletLedgerEntryMapper = {
    toDomain(record: WalletLedgerEntriesRecord): WalletLedgerEntry {
        return WalletLedgerEntry.rehydrate({
            id: record.id,
            walletId: record.walletId,
            transactionId: record.transactionId,
            direction: record.direction as LedgerDirection,
            money: { amount: record.amount, currency: record.currency },
            balanceBefore: { amount: record.balanceBefore, currency: record.currency },
            balanceAfter: { amount: record.balanceAfter, currency: record.currency },
            createdAt: record.createdAt,
        });
    },

    toPersistence(entry: WalletLedgerEntry): WalletLedgerEntriesRecord {
        const { amount, currency } = entry.money.toJSON();
        return {
            id: entry.id,
            walletId: entry.walletId,
            transactionId: entry.transactionId,
            direction: entry.direction,
            amount,
            balanceBefore: entry.balanceBefore.toJSON().amount,
            balanceAfter: entry.balanceAfter.toJSON().amount,
            currency,
            createdAt: entry.createdAt,
        };
    },
};

export const WagerTransactionMapper = {
    toDomain(record: WagerTransactionRecord): StoredWagerTransaction {
        return {
            transaction: WagerTransaction.rehydrate({
                id: record.id,
                providerId: record.providerId,
                externalTransactionId: record.externalTransactionId,
                idempotencyKey: record.idempotencyKey,
                payloadHash: record.payloadHash,
                walletId: record.walletId,
                playerId: record.playerId,
                roundId: record.roundId,
                gameId: record.gameId,
                kind: record.kind as WagerTransactionKind,
                money: { amount: record.amount, currency: record.currency },
                referenceExternalTransactionId: record.referenceExternalTransactionId ?? undefined,
                createdAt: record.createdAt,
                status: record.status as WagerTransactionStatus,
                referenceTransactionId: record.referenceTransactionId ?? undefined,
                failureCode: (record.failureCode as FailureCode | null) ?? undefined,
                processedAt: record.processedAt ?? undefined,
            }),
            observedBalance: record.observedBalance ?? undefined,
        };
    },

    toPersistence(tx: WagerTransaction, observedBalance?: string): WagerTransactionRecord {
        const { amount, currency } = tx.money.toJSON();
        return {
            id: tx.id,
            providerId: tx.providerId,
            externalTransactionId: tx.externalTransactionId,
            idempotencyKey: tx.idempotencyKey,
            payloadHash: tx.payloadHash,
            walletId: tx.walletId,
            playerId: tx.playerId,
            roundId: tx.roundId,
            gameId: tx.gameId,
            kind: tx.kind,
            amount,
            observedBalance: observedBalance ?? null,
            currency,
            status: tx.status,
            referenceExternalTransactionId: tx.referenceExternalTransactionId ?? null,
            referenceTransactionId: tx.referenceTransactionId ?? null,
            failureCode: tx.failureCode ?? null,
            referenceAttempts: 0,
            referenceNextAttemptAt: null,
            createdAt: tx.createdAt,
            processedAt: tx.processedAt ?? null,
        };
    },
};

export const InboxMessageMapper = {
    toDomain(record: InboxMessageRecord): InboxMessage {
        return InboxMessage.rehydrate({
            messageId: record.messageId,
            consumerName: record.consumerName,
            payloadHash: record.payloadHash,
            receivedAt: record.receivedAt,
            processedAt: record.processedAt ?? undefined,
        });
    },

    toPersistence(message: InboxMessage): InboxMessageRecord {
        return {
            consumerName: message.consumerName,
            messageId: message.messageId,
            payloadHash: message.payloadHash,
            receivedAt: message.receivedAt,
            processedAt: message.processedAt ?? null,
        };
    },
};

export const OutboxMessageMapper = {
    toDomain(record: OutboxMessageRecord): OutboxMessage {
        return OutboxMessage.rehydrate({
            id: record.id,
            aggregateId: record.aggregateId,
            eventType: record.eventType,
            payload: record.payload,
            occurredAt: record.occurredAt.toISOString(),
            attempts: record.attempts,
            nextAttemptAt: record.nextAttemptAt ? record.nextAttemptAt.toISOString() : undefined,
            publishedAt: record.publishedAt ? record.publishedAt.toISOString() : undefined,
        });
    },

    toPersistence(message: OutboxMessage): OutboxMessageRecord {
        return {
            id: message.id,
            aggregateId: message.aggregateId,
            eventType: message.eventType,
            payload: { ...message.payload },
            occurredAt: message.occurredAt,
            attempts: message.attempts,
            nextAttemptAt: message.nextAttemptAt ?? null,
            publishedAt: message.publishedAt ?? null,
        };
    },
};