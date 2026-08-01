import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AIProvider } from '@cbd/ai';
import { SettingsService, type ResolvedParams } from '../settings/settings.service.js';
import { CapabilityGate } from './capability-gate.service.js';
import type { GenerationParams } from '@cbd/ai';

/**
 * settings -> decrypted key -> constructed adapter.
 *
 * The registry is the only thing that knows how to turn stored configuration
 * into a live provider, and it is deliberately the thing e2e tests override.
 * Because the engine receives a provider as an argument rather than resolving
 * one, overriding this class is the entire mocking strategy — no SDK is ever
 * stubbed, because nothing downstream imports one.
 */

export interface ActiveProvider {
  provider: AIProvider;
  providerId: string;
  providerKind: 'GOOGLE' | 'ANTHROPIC';
  model: string;
  /** Raw configured values, before capability negotiation. */
  settings: ResolvedParams;
  /** What should actually be sent to this provider. */
  params: GenerationParams;
}

/** The specific 503 the web app renders as a configuration notice. */
export class NoActiveProviderException extends ServiceUnavailableException {
  constructor(reason: string, detail: string) {
    super({
      code: reason,
      message: detail,
      action: 'Configure a provider at /admin/providers.',
    });
  }
}

@Injectable()
export class ProviderRegistry {
  constructor(
    private readonly settings: SettingsService,
    private readonly gate: CapabilityGate,
  ) {}

  /**
   * Throws NoActiveProviderException rather than returning null, so that no
   * caller can accidentally proceed with an unconfigured provider. The degraded
   * path is explicit at every call site.
   */
  async requireActive(): Promise<ActiveProvider> {
    const resolved = await this.settings.resolve();

    if (!resolved.provider || !resolved.activeModel || !resolved.providerId
      || !resolved.providerKind) {
      throw new NoActiveProviderException(
        resolved.degradedReason ?? 'NO_ACTIVE_PROVIDER',
        describe(resolved.degradedReason),
      );
    }

    return {
      provider: resolved.provider,
      providerId: resolved.providerId,
      providerKind: resolved.providerKind,
      model: resolved.activeModel,
      settings: resolved.params,
      params: this.gate.negotiate(resolved.provider, resolved.params),
    };
  }

  /** For /health and the admin status card, where absence is not an error. */
  async tryActive(): Promise<ActiveProvider | null> {
    try {
      return await this.requireActive();
    } catch {
      return null;
    }
  }
}

function describe(reason: string | null): string {
  switch (reason) {
    case 'NO_CREDENTIAL':
      return 'A provider is selected but has no API key stored.';
    case 'CREDENTIAL_UNREADABLE':
      return 'The stored API key could not be decrypted. Re-enter it in the admin panel.';
    case 'PROVIDER_UNAVAILABLE':
      // Distinct from NO_ACTIVE_PROVIDER on purpose: a provider IS selected, so
      // "none configured" would send an admin looking for a setting that is
      // already set. The fix is to select a different provider, not to add one.
      return 'The selected provider has no adapter in this build. '
        + 'Select a different provider in the admin panel.';
    default:
      return 'No AI provider is configured yet.';
  }
}
