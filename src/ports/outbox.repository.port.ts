import type { OutboxMessage } from "../domain/messages/outbox";

export interface OutboxRepository {
    enqueue(message: OutboxMessage): Promise<void>;
    /** Seleciona lote pronto para envio com FOR UPDATE SKIP LOCKED (seguro com vários publishers). */
    claimPendingBatch(now: Date, limit: number): Promise<OutboxMessage[]>;
    save(message: OutboxMessage): Promise<void>;
}