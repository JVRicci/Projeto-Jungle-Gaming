import type { Wallet } from "../domain/wallet/wallet";
import type { WalletLedgerEntry } from "../domain/wallet/wallet_ledger_entry";

export interface LedgerPage {
    items: WalletLedgerEntry[];
    nextCursor: string | null;
}

export interface LedgerReconciliationSummary {
    calculatedAmount: string;
    checkedEntries: number;
}

export interface WalletRepository {
    findById(id: string): Promise<Wallet | null>;
    /** Carrega com SELECT ... FOR UPDATE (lock exclusivo por walletId na transação). */
    findByIdForUpdate(id: string): Promise<Wallet | null>;
    findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
    create(wallet: Wallet): Promise<void>;
    save(wallet: Wallet): Promise<void>;
    appendLedgerEntry(entry: WalletLedgerEntry): Promise<void>;
    listLedgerEntries(params: {
        walletId: string;
        cursor?: string;
        limit: number;
    }): Promise<LedgerPage>;
    calculateBalanceFromLedger(walletId: string): Promise<LedgerReconciliationSummary>;
}