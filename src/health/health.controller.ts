import { Controller, Get, Injectable } from '@nestjs/common';
import { ClockService } from './clock_service'; 

@Controller('health')
export class HealthController {
    constructor(private readonly clock: ClockService) {}

    @Get('live')
    live(){
        return {status: 'ok', timestamp: this.clock.now().toISOString() };
    }
}