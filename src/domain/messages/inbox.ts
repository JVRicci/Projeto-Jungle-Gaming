
interface InboxMessageState {
  
    messageId: string,
    consumerName: string,
    payloadHash: string,
    receivedAt: Date,
    _processedAt?: Date,
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage;
  static rehydrate(state: InboxMessageState): InboxMessage;

  get processedAt(): Date | undefined { return this._processedAt; }

  isProcessed(): boolean;
  markProcessed(at: Date): void;
}

