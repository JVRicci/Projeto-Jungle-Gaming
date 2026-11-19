import { Module } from '@nestjs/common';
import { ClockService, HealthController } from './health/health.controller';

@Module({
    controllers: [HealthController],
    providers: [ClockService],
})
export class AppModule{}