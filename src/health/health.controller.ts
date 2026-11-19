import { Controller, Get, Injectable } from '@nestjs/common';

@Injectable()
export class ClockService {
    now(): Date {
        return new Date();
    }
}

@Controller('health')
export class HealthController {
    constructor(private readonly clock: ClockService) {}

    @Get('live')
    live(){
        return {status: 'ok', timestamp: this.clock.now().toISOString() };
    }
}