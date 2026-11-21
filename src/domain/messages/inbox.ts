import{DomainError} from "../shared/domain-error"

export interface ReceiveInboxProps{
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date
}
export interface InboxMessageState {
    messageId: string,
    consumerName: string,
    payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    if (!props.messageId || !props.consumerName || !props.payloadHash) {
      throw new DomainError("INVALID_INBOX_PROPS", "messageId, consumerName e payloadHash são obrigatórios");
    }

    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      props.receivedAt ?? new Date(),
      undefined
    );
  };

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt),
      state.processedAt ? new Date(state.processedAt) : undefined
    );
  };

  get processedAt(): Date | undefined { return this._processedAt; }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  };

  markProcessed(at: Date): void {
    this._processedAt = at
  };
}

