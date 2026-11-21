import Decimal from "decimal.js";
import { DomainError } from "../../domain/shared/domain-error";
import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import type { Wallet } from "../../domain/wallet/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../domain/wallet/wallet_ledger_entry";
import type {
    LedgerPage,
    LedgerReconciliationSummary,
    WalletRepository,
} from "../../ports/wallet.repository.port";
import { WalletLedgerEntries, WalletOrmEntity } from "../entities";
import { WalletLedgerEntryMapper, WalletMapper } from "../mappers";

interface LedgerCursorPayload {
    createdAt: string;
    id: string;
}

const D = Decimal.clone({ precision: 40 });

@Injectable()
export class MikroOrmWalletRepository implements WalletRepository {
    constructor(private readonly em: EntityManager) {}

    async findById(id: string): Promise<Wallet | null> {
        const record = await this.em.findOne(WalletOrmEntity, { id });
        return record ? WalletMapper.toDomain(record) : null;
    }

    async findByIdForUpdate(id: string): Promise<Wallet | null> {
        const record = await this.em.findOne(
            WalletOrmEntity,
            { id },
            { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
        );
        return record ? WalletMapper.toDomain(record) : null;
    }

    async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
        const record = await this.em.findOne(WalletOrmEntity, { playerId, currency });
        return record ? WalletMapper.toDomain(record) : null;
    }

    async create(wallet: Wallet): Promise<void> {
        this.em.create(WalletOrmEntity, WalletMapper.toPersistence(wallet));
        await this.em.flush();
    }

    async save(wallet: Wallet): Promise<void> {
        const ref = this.em.getReference(WalletOrmEntity, wallet.id);
        ref.balance = wallet.balance.toJSON().amount;
        ref.version = wallet.version;
        ref.updatedAt = wallet.updatedAt;
        await this.em.flush();
    }

    async appendLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
        this.em.create(WalletLedgerEntries, WalletLedgerEntryMapper.toPersistence(entry));
        await this.em.flush();
    }

    async listLedgerEntries(params: {
        walletId: string;
        cursor?: string;
        limit: number;
    }): Promise<LedgerPage> {
        const decoded = params.cursor ? this.decodeCursor(params.cursor) : null;

        const where = decoded
            ? {
                  walletId: params.walletId,
                  $or: [
                      { createdAt: { $lt: new Date(decoded.createdAt) } },
                      { createdAt: new Date(decoded.createdAt), id: { $lt: decoded.id } },
                  ],
              }
            : { walletId: params.walletId };

        const rows = await this.em.find(WalletLedgerEntries, where, {
            orderBy: { createdAt: "DESC", id: "DESC" },
            limit: params.limit + 1,
        });

        const hasMore = rows.length > params.limit;
        const pageRows = hasMore ? rows.slice(0, params.limit) : rows;
        const last = pageRows[pageRows.length - 1];

        return {
            items: pageRows.map(WalletLedgerEntryMapper.toDomain),
            nextCursor: hasMore && last ? this.encodeCursor(last.createdAt, last.id) : null,
        };
    }

    async calculateBalanceFromLedger(walletId: string): Promise<LedgerReconciliationSummary> {
        const entries = await this.em.find(
            WalletLedgerEntries,
            { walletId },
            { fields: ["direction", "amount"] },
        );

        let total = new D(0);
        for (const entry of entries) {
            const amount = new D(entry.amount);
            total = entry.direction === LedgerDirection.Credit
                ? total.plus(amount)
                : total.minus(amount);
        }

        return {
            calculatedAmount: total.isZero() ? "0.00" : total.toFixed(2),
            checkedEntries: entries.length,
        };
    }

    private encodeCursor(createdAt: Date, id: string): string {
        const payload: LedgerCursorPayload = { createdAt: createdAt.toISOString(), id };
        return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    }

    private decodeCursor(cursor: string): LedgerCursorPayload {
        try {
            const parsed = JSON.parse(
                Buffer.from(cursor, "base64url").toString("utf8"),
            ) as Partial<LedgerCursorPayload>;
            if (
                typeof parsed.createdAt !== "string" ||
                typeof parsed.id !== "string" ||
                Number.isNaN(Date.parse(parsed.createdAt))
            ) {
                throw new Error("shape");
            }
            return { createdAt: parsed.createdAt, id: parsed.id };
        } catch {
            throw new DomainError("INVALID_CURSOR", "Cursor de paginação inválido");
        }
    }
}