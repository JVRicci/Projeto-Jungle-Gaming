import { GetQueueAttributesCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { EntityManager } from "@mikro-orm/postgresql";
import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { SQS_CLIENT } from "../messaging/sqs_client";
import { ClockService } from "./clock_service";

@Controller("health")
export class HealthController {
    constructor(
        private readonly clock: ClockService,
        private readonly em: EntityManager,
        @Inject(SQS_CLIENT) private readonly sqs: SQSClient,
    ) {}

    @Get("live")
    live() {
        return { status: "ok", timestamp: this.clock.now().toISOString() };
    }

    @Get("ready")
    async ready() {
        let postgres = "ok";
        let sqs = "ok";

        try {
            await this.em.execute("SELECT 1");
        } catch {
            postgres = "error";
        }

        try {
            const queueUrl = process.env.SQS_WAGER_QUEUE_URL;
            if (!queueUrl) throw new Error("SQS_WAGER_QUEUE_URL ausente");
            await this.sqs.send(
                new GetQueueAttributesCommand({
                    QueueUrl: queueUrl,
                    AttributeNames: ["QueueArn"],
                }),
            );
        } catch {
            sqs = "error";
        }

        const payload = {
            status: postgres === "ok" && sqs === "ok" ? "ready" : "not_ready",
            checks: { postgres, sqs },
            timestamp: this.clock.now().toISOString(),
        };

        if (payload.status !== "ready") {
            throw new ServiceUnavailableException(payload);
        }
        return payload;
    }
}