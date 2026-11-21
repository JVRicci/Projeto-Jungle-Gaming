import { Module } from "@nestjs/common";
import { DatabaseModule } from "../database/database.module";
import { HttpModule } from "../http/http.module";
import { OutboxPublisherWorker } from "./outbox_publisher.worker";
import { PendingReferenceWorker } from "./pending_reference.worker";
import { SQS_CLIENT, createSqsClient } from "./sqs_client";
import { SqsWagerConsumer } from "./sqs_wager.consumer";

@Module({
    imports: [DatabaseModule, HttpModule],
    providers: [
        { provide: SQS_CLIENT, useFactory: createSqsClient },
        OutboxPublisherWorker,
        PendingReferenceWorker,
        SqsWagerConsumer,
    ],
    exports: [SQS_CLIENT, OutboxPublisherWorker, PendingReferenceWorker, SqsWagerConsumer],
})
export class MessagingModule {}