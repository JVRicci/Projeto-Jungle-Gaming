import Decimal from "decimal.js";
import { DomainError } from "../shared/domain-error";
import { Money, type MoneyProps } from "../money/money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet_ledger_entry";

interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
  }): Wallet {
    const { id, playerId, initialBalance } = props;

    if (!id || !playerId) {
      throw new DomainError("MISSING_REQUIRED_PLAYER_ID", "Verificação de carteira inválida: id ou playerId ausentes");
    }

    if (props.initialBalance.isNegative()) {
      throw new DomainError("INITIAL_BALANCE_NEGATIVE", "Saldo inicial não pode ser negativo");
    }

    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      new Date(),
      new Date(),
    );
  };

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.from(state.balance),
      state.version,
      new Date(state.createdAt),
      new Date(state.updatedAt),
    );
  };

  get balance(): Money { return this._balance; }
  get version(): number { return this._version; }
  get updatedAt(): Date { return this._updatedAt; }

  // Aplicam a movimentação mantendo saldo e ledger consistentes entre si.
  // Assinatura e retorno são decisão sua.
  debit(props: {ledgerEntryId: string, transactionId: string, money: Money, at: Date}): WalletLedgerEntry {
    const {ledgerEntryId, transactionId, money, at} = props;

    this.assertSameCurrency(money);

    if(money.isNegative() || money.isZero()){
      throw new DomainError("INVALID_DEBIT_AMOUNT", "Valor de débito inválido");
    }

    if(this._balance.isNegative() || this._balance.isZero() || this._balance.isLessThan(money)){
      throw new DomainError("INSUFFICIENT_FUNDS", "Saldo insuficiente para débito");
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.subtract(money);

    const entry = WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Debit,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    })

    this._balance = balanceAfter;
    this._version++;
    this._updatedAt = at;

    return entry
  };

  credit(props: {ledgerEntryId: string, transactionId: string, money: Money, at: Date}): WalletLedgerEntry{
    const {ledgerEntryId, transactionId, money, at} = props;

    this.assertSameCurrency(money);
    
    if(!money.isPositive()){
      throw new DomainError("INVALID_CREDIT_AMOUNT", "Valor de crédito deve ser positivo");
    }

    const balanceBefore = this._balance;
    const balanceAfter = this._balance.add(money);

    const entry = WalletLedgerEntry.create({
      id: ledgerEntryId,
      walletId: this.id,
      transactionId,
      direction: LedgerDirection.Credit,
      money,
      balanceBefore,
      balanceAfter,
      createdAt: at,
    })

    this._balance = balanceAfter;
    this._version++;
    this._updatedAt = at;

    return entry;
  }

  private assertSameCurrency(money: Money): void{
    if(this.currency !== money.currency){
      throw new DomainError("CURRENCY_MISMATCH", `Moeda incompatível: ${money.currency} (esperada: ${this.currency})`);
    }
  };
}