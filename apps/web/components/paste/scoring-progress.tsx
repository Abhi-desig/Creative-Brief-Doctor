import type { StreamPhase } from '@/lib/sse-client';

/**
 * Aliased rather than redeclared: the phase names are a wire contract with the
 * API's `StatusPhase`, and having the display component own a second copy of the
 * union meant a renamed phase would typecheck on both sides and silently stop
 * matching. Type-only import, so nothing is pulled in at runtime.
 */
export type Phase = StreamPhase;

const COPY: Record<Phase, string> = {
  reading: 'Reading the brief',
  scoring: 'Working through the five dimensions',
  saving: 'Putting the report together',
};

const ORDER: Phase[] = ['reading', 'scoring', 'saving'];

/**
 * Coarse status only — the SSE contract never carries partial JSON, so there is
 * nothing finer to show and nothing provider-specific leaks into the UI.
 */
export function ScoringProgress({ phase }: { phase: Phase }) {
  const index = ORDER.indexOf(phase);
  return (
    <div className="flex items-center gap-3" aria-live="polite">
      <div className="flex gap-1.5" aria-hidden="true">
        {ORDER.map((p, i) => (
          <span
            key={p}
            className={`h-1 rounded-full transition-all ${
              i <= index ? 'bg-viz-fill w-6' : 'bg-viz-track w-3'
            }`}
            style={{ transitionDuration: 'var(--dur-base)' }}
          />
        ))}
      </div>
      <p className="text-muted-foreground text-sm">{COPY[phase]}</p>
    </div>
  );
}
