import { Injectable, Logger } from '@nestjs/common';
import type { AIProvider, GenerationParams } from '@cbd/ai';
import type { ResolvedParams } from '../settings/settings.service.js';

/**
 * Negotiates requested parameters against what the adapter declares it can do.
 *
 * The adapter drops unsupported parameters itself — that is a conformance
 * requirement. This gate exists one level up so the ADMIN FORM and the engine
 * see the same answer the adapter would give, which is what stops the UI
 * offering a control the selected model rejects.
 */
@Injectable()
export class CapabilityGate {
  private readonly logger = new Logger(CapabilityGate.name);

  /** Parameters actually worth sending, given the provider's capabilities. */
  negotiate(provider: AIProvider, params: ResolvedParams): GenerationParams {
    const caps = provider.capabilities;
    const out: GenerationParams = {
      maxTokens: Math.min(params.maxTokens, caps.maxOutputTokens),
      timeoutMs: params.timeoutMs,
      maxRetries: params.maxRetries,
    };

    if (params.temperature !== undefined && caps.supportsTemperature) {
      out.temperature = params.temperature;
    }
    if (params.topP !== undefined && caps.supportsTopP) out.topP = params.topP;
    if (params.thinkingBudget !== undefined && caps.supportsThinkingBudget) {
      out.thinkingBudget = params.thinkingBudget;
    }

    if (params.maxTokens > caps.maxOutputTokens) {
      this.logger.warn(
        `maxTokens ${params.maxTokens} exceeds ${provider.id} limit `
        + `${caps.maxOutputTokens}; clamped.`,
      );
    }
    return out;
  }

  /** Which controls the admin form should render for this provider. */
  formControls(provider: AIProvider): Record<string, boolean> {
    const caps = provider.capabilities;
    return {
      maxTokens: true,
      temperature: caps.supportsTemperature,
      topP: caps.supportsTopP,
      thinkingBudget: caps.supportsThinkingBudget,
      timeoutMs: true,
      maxRetries: true,
      tokenCeiling: true,
      dailyCallCap: true,
    };
  }
}
