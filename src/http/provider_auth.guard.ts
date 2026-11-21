import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";

/**
 * Ponto de extensão para autenticação de provedores (ex.: JWT OIDC via Keycloak/Zitadel).
 * Atualmente no-op conforme permitido na Seção 2 do desafio; endpoints /health/* permanecem abertos.
 */
@Injectable()
export class ProviderAuthGuard implements CanActivate {
    canActivate(_context: ExecutionContext): boolean {
        return true;
    }
}