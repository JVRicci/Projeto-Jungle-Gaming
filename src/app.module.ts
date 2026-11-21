import { ClockService } from './health/clock_service';
import { HealthController } from './health/health.controller';
import { Module } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { HttpModule } from './http/http.module';

@Module({    
    imports: [DatabaseModule, HttpModule],
    controllers: [HealthController],
    providers: [ClockService],
})
export class AppModule{}