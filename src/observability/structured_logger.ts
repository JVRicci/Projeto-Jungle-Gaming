import { Injectable } from "@nestjs/common";

export interface LogContext {
    correlationId?: string;
    messageId?: string;
    transactionId?: string;
    walletId?: string;
    providerId?: string;
    status?: string;
    failureCode?: string;
    idempotentReplay?: boolean;
    durationMs?: number;
    attempts?: number;
    receiveCount?: number;
    backoffSeconds?: number;
    checkedEntries?: number;
    reason?: string;
    message?: string;
}

@Injectable()
export class StructuredLogger {
    info(event: string, context: LogContext = {}): void {
        this.write("info", event, context);
    }

    warn(event: string, context: LogContext = {}): void {
        this.write("warn", event, context);
    }

    error(event: string, context: LogContext = {}): void {
        this.write("error", event, context);
    }

    private write(level: "info" | "warn" | "error", event: string, context: LogContext): void {
        const line = JSON.stringify({
            timestamp: new Date().toISOString(),
            level,
            event,
            ...context,
        });
        if (level === "error") {
            console.error(line);
        } else if (level === "warn") {
            console.warn(line);
        } else {
            console.log(line);
        }
    }
}