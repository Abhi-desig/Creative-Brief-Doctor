import { GoogleAdapter, type AIProvider } from '@cbd/ai';

/**
 * The one place a ProviderKind becomes a concrete adapter.
 *
 * This is the seam the whole abstraction exists to keep small: adding a
 * provider is one enum value plus one case here plus one adapter file, and
 * nothing else in apps/api branches on provider.
 */
export interface AdapterSpec {
  kind: 'GOOGLE' | 'ANTHROPIC';
  apiKey: string;
  baseUrl?: string | undefined;
  thinkingBudget?: number | undefined;
}

export function buildAdapter(spec: AdapterSpec): AIProvider {
  switch (spec.kind) {
    case 'GOOGLE':
      return new GoogleAdapter({
        apiKey: spec.apiKey,
        baseUrl: spec.baseUrl,
        thinkingBudget: spec.thinkingBudget,
      });
    case 'ANTHROPIC':
      // Deliberately not built yet. The port, the conformance suite and the
      // error taxonomy are all provider-neutral, so this is one file plus one
      // conformance run whenever it is wanted — see the seam note in
      // packages/ai. Failing loudly beats silently falling back to Google,
      // which would produce scores attributed to the wrong model.
      throw new Error(
        'The Anthropic adapter is not implemented yet. Select a Google provider, '
        + 'or add packages/ai/src/adapters/anthropic.adapter.ts and run the '
        + 'conformance suite against it.',
      );
    default: {
      const exhaustive: never = spec.kind;
      throw new Error(`Unknown provider kind: ${String(exhaustive)}`);
    }
  }
}
