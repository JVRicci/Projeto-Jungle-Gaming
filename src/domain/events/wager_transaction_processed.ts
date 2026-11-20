import { type EventContext } from "./event_context";
import { WagerTransaction, WagerTransactionKind } from "../wager/wager_transaction";
import { type MoneyProps } from "../money/money";
import { IntegrationEvent } from "../messages/integration_event";

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceTransactionId?: string;
  referenceExternalTransactionId?: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(props: {
    transaction: WagerTransaction;
    context: EventContext;
  }): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: crypto.randomUUID(),
      aggregateId: props.transaction.id,
      correlationId: props.context.correlationId,
      causationId: props.context.causationId,
      occurredAt: props.transaction.processedAt ?? new Date(),
      data: {
        transactionId: props.transaction.id,
        providerId: props.transaction.providerId,
        externalTransactionId: props.transaction.externalTransactionId,
        playerId: props.transaction.playerId,
        walletId: props.transaction.walletId,
        roundId: props.transaction.roundId,
        gameId: props.transaction.gameId,
        kind: props.transaction.kind,
        money: props.transaction.money.toJSON(),
        referenceTransactionId: props.transaction.referenceTransactionId,
        referenceExternalTransactionId: props.transaction.referenceExternalTransactionId,
      },
    });
  }
}