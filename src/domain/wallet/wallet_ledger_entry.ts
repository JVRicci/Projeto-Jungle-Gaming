import { DomainError } from "../shared/domain-error";
import { Money, type MoneyProps } from "../money/money";

export enum LedgerDirection { Debit = "DEBIT", Credit = "CREDIT" }

interface CreateLedgerEntryProps {
    id: string;  
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
    createdAt?: Date;
}

interface LedgerEntryState {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: Date;
}

export class WalletLedgerEntry {
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly money: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        public readonly createdAt: Date,
    ) {}

    static create(props: CreateLedgerEntryProps): WalletLedgerEntry{
        const {id, walletId, transactionId, direction, money, balanceBefore, balanceAfter, createdAt = new Date()} = props;
        
        if(!props.id || !props.walletId || !props.transactionId)
            throw new DomainError("INVALID_ID", "ID da carteira, transação ou registro inválido")
        
        if(!money.isPositive())
            throw new DomainError("INVALID_LEDGER_AMOUNT", "Valor lançamento inválido ")

        const entry = new WalletLedgerEntry(
            id,
            walletId,
            transactionId,
            direction,
            money,
            balanceBefore,
            balanceAfter,
            createdAt
        );
        
        if(!entry.isBalanced()){
            throw new DomainError("LEDGER_ENTRY_NOT_BALANCED", "Saldo de lançamento inválido");
        }

        return entry;
    };

    static rehydrate(state: LedgerEntryState): WalletLedgerEntry{
        return new WalletLedgerEntry(
            state.id,
            state.walletId,
            state.transactionId,
            state.direction,
            Money.rehydrate(state.money),
            Money.rehydrate(state.balanceBefore),
            Money.rehydrate(state.balanceAfter),
            new Date(state.createdAt)
        );
    };

    /** balanceBefore ± money === balanceAfter. Verificada na factory. */
    isBalanced(): boolean {
        
        const expectBalance = this.direction === LedgerDirection.Debit
            ? this.balanceBefore.subtract(this.money)
            : this.balanceBefore.add(this.money);
            
        return expectBalance.equals(this.balanceAfter);
    };
}