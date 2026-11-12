import { Injectable } from '@nestjs/common';

export abstract class ProviderIdentityPort {
  abstract assertProvider(providerId: string): Promise<void>;
}

@Injectable()
export class NoopProviderIdentityAdapter implements ProviderIdentityPort {
  async assertProvider(_providerId: string): Promise<void> {
    // Replace with an OIDC-backed adapter when authentication is introduced.
  }
}
