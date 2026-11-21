import { type EventContext } from "./event_context";
import { IntegrationEvent } from "../messages/integration_event";
import { type MoneyProps } from "../money/money";
import { WagerTransaction, WagerTransactionKind } from "../wager/wager_transaction";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  referenceExternalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(props: {
    transaction: WagerTransaction;
    context: EventContext;
  }): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: crypto.randomUUID(),
      aggregateId: props.transaction.id,
      correlationId: props.context.correlationId,
      causationId: props.context.causationId,
      occurredAt: props.transaction.createdAt,
      data: {
        transactionId: props.transaction.id,
        providerId: props.transaction.providerId,
        externalTransactionId: props.transaction.externalTransactionId,
        referenceExternalTransactionId: props.transaction.referenceExternalTransactionId!,
        walletId: props.transaction.walletId,
        playerId: props.transaction.playerId,
        roundId: props.transaction.roundId,
        gameId: props.transaction.gameId,
        kind: props.transaction.kind,
        money: props.transaction.money.toJSON(),
      },
    });
  }
}