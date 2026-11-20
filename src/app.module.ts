import { ClockService } from './health/clock_service';
import { HealthController } from './health/health.controller';
import { Module } from '@nestjs/common';

@Module({
    controllers: [HealthController],
    providers: [ClockService],
})
export class AppModule{}