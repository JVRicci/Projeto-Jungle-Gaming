import { ClockService } from './health/clock_service';
import { HealthController } from './health/health.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HttpModule } from './http/http.module';
import { MessagingModule } from './messaging/messaging.module';
import { ObservabilityModule } from './observability/observability.module';

@Module({    
    imports: [ObservabilityModule, DatabaseModule, HttpModule, MessagingModule],
    controllers: [HealthController],
    providers: [ClockService],
})
export class AppModule{}