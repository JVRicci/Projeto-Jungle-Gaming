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
    createdAt: Date;
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
        const { direction, money, balanceBefore, balanceAfter } = props;
        
        const entry = new WalletLedgerEntry(
            props.id,
            props.walletId,
            props.transactionId,
            props.direction,
            props.money,
            props.balanceBefore,
            props.balanceAfter,
            props.createdAt
        );
        
        if(!entry.isBalanced(props.direction, money, props.balanceBefore, balanceAfter)){
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
            Money.from(state.money),
            Money.from(state.balanceBefore),
            Money.from(state.balanceAfter),
            new Date(state.createdAt)
        );
    };

    /** balanceBefore ± money === balanceAfter. Verificada na factory. */
    isBalanced(direction: LedgerDirection, money: Money, balanceBefore: Money, balanceAfter: Money): boolean {
        
        const expectBalance = direction === LedgerDirection.Debit
            ? balanceBefore.subtract(money)
            : balanceBefore.add(money);
            
        return expectBalance.equals(balanceAfter);
    };
}