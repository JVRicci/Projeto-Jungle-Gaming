import { EntityManager } from "@mikro-orm/postgresql";
import { Controller, Get } from "@nestjs/common";
import { OutboxMessageOrmEntity } from "../database/entities";
import { MetricsService } from "./metrics.service";

@Controller("metrics")
export class MetricsController {
    constructor(
        private readonly metrics: MetricsService,
        private readonly em: EntityManager,
    ) {}

    @Get()
    async getMetrics() {
        const pending = await this.em.find(
            OutboxMessageOrmEntity,
            { publishedAt: null },
            { orderBy: { occurredAt: "ASC" }, fields: ["occurredAt"] },
        );

        const oldest = pending[0];
        const oldestPendingAgeMs = oldest
            ? Math.max(0, Date.now() - oldest.occurredAt.getTime())
            : 0;

        return this.metrics.snapshot({
            pendingCount: pending.length,
            oldestPendingAgeMs,
        });
    }
}