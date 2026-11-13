import { Injectable } from '@nestjs/common';

export abstract class ProviderIdentityPort {
  /** Valida se o provedor está autorizado a enviar transações. */
  abstract assertProvider(providerId: string): Promise<void>;
}

@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  /** Ponto provisório sem autenticação, a ser substituído por integração OIDC. */
  async assertProvider(_providerId: string): Promise<void> {
    // A validação real deve ser implementada por um adaptador conectado a um IdP OIDC.
  }
}
