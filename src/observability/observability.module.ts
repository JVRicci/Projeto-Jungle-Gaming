import { Global, Module } from "@nestjs/common";
import { MetricsController } from "./metrics.controller";
import { MetricsService } from "./metrics.service";
import { StructuredLogger } from "./structured_logger";

@Global()
@Module({
    controllers: [MetricsController],
    providers: [MetricsService, StructuredLogger],
    exports: [MetricsService, StructuredLogger],
})
export class ObservabilityModule {}