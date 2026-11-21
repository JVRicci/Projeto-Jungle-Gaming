import { EntityManager } from "@mikro-orm/postgresql";
import { Injectable } from "@nestjs/common";
import type { InboxMessage } from "../../domain/messages/inbox";
import type { InboxRepository } from "../../ports/inbox.repository.port";
import { InboxMessageOrmEntity } from "../entities";
import { InboxMessageMapper } from "../mappers";

@Injectable()
export class MikroOrmInboxRepository implements InboxRepository {
    constructor(private readonly em: EntityManager) {}

    async findByKey(consumerName: string, messageId: string): Promise<InboxMessage | null> {
        const record = await this.em.findOne(InboxMessageOrmEntity, { consumerName, messageId });
        return record ? InboxMessageMapper.toDomain(record) : null;
    }

    async create(message: InboxMessage): Promise<void> {
        this.em.create(InboxMessageOrmEntity, InboxMessageMapper.toPersistence(message));
        await this.em.flush();
    }

    async save(message: InboxMessage): Promise<void> {
        await this.em.nativeUpdate(
            InboxMessageOrmEntity,
            { consumerName: message.consumerName, messageId: message.messageId },
            { processedAt: message.processedAt ?? null },
        );
    }
}