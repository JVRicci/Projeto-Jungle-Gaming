import type { InboxMessage } from "../domain/messages/inbox";

export interface InboxRepository {
    findByKey(consumerName: string, messageId: string): Promise<InboxMessage | null>;
    create(message: InboxMessage): Promise<void>;
    save(message: InboxMessage): Promise<void>;
}