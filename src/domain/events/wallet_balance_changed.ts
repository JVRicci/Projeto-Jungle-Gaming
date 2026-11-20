import { type EventContext } from "./event_context";
import { IntegrationEvent } from "../messages/integration_event";
import { LedgerDirection } from "../wallet/wallet_ledger_entry";
import { type MoneyProps } from "../money/money";
import { Wallet } from "../wallet/wallet";
import { WalletLedgerEntry } from "../wallet/wallet_ledger_entry";

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(props: {
    wallet: Wallet;
    entry: WalletLedgerEntry;
    context: EventContext;
  }): WalletBalanceChanged {
    return new WalletBalanceChanged({
      eventId: crypto.randomUUID(),
      aggregateId: props.wallet.id,
      correlationId: props.context.correlationId,
      causationId: props.context.causationId,
      occurredAt: props.entry.createdAt,
      data: {
        walletId: props.wallet.id,
        transactionId: props.entry.transactionId,
        direction: props.entry.direction,
        money: props.entry.money.toJSON(),
        balanceBefore: props.entry.balanceBefore.toJSON(),
        balanceAfter: props.entry.balanceAfter.toJSON(),
        walletVersion: props.wallet.version,
      },
    });
  }
}