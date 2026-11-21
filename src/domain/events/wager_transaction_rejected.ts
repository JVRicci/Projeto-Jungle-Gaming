import { type EventContext } from "./event_context";
import { FailureCode } from "../wager/wager_transaction";
import { IntegrationEvent } from "../messages/integration_event";
import { type MoneyProps } from "../money/money";
import { WagerTransaction, WagerTransactionKind } from "../wager/wager_transaction";

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  referenceExternalTransactionId?: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(props: {
    transaction: WagerTransaction;
    context: EventContext;
  }): WagerTransactionRejected {
    return new WagerTransactionRejected({
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
        failureCode: props.transaction.failureCode!,
        referenceExternalTransactionId: props.transaction.referenceExternalTransactionId,
      },
    });
  }
}