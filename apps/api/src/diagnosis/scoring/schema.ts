import { DiagnosisOutputParseSchema, type DiagnosisOutput } from '@cbd/contracts';
import { isRepairFailure, repairJson, type RepairStrategy } from './repair.js';

/**
 * Parse-and-validate, with one bounded repair attempt.
 *
 * Plain functions, no decorators. The contract schema is the only validator —
 * there is no second, looser shape for "nearly valid" output.
 */

export interface ParseSuccess {
  ok: true;
  output: DiagnosisOutput;
  strategy: RepairStrategy;
  repaired: boolean;
}

export interface ParseFailure {
  ok: false;
  /** Fed back to the model on the single retry, so it can see what was wrong. */
  validatorError: string;
  stage: 'json' | 'schema';
}

export function parseDiagnosis(raw: string): ParseSuccess | ParseFailure {
  const repaired = repairJson(raw);
  if (isRepairFailure(repaired)) {
    return {
      ok: false,
      stage: 'json',
      validatorError:
        `Response was not valid JSON. Tried: ${repaired.attempted.join(', ')}. `
        + 'Return a single JSON object and nothing else — no prose, no markdown fence.',
    };
  }

  const parsed = DiagnosisOutputParseSchema.safeParse(repaired.value);
  if (!parsed.success) {
    return {
      ok: false,
      stage: 'schema',
      validatorError: formatIssues(parsed.error.issues),
    };
  }

  return {
    ok: true,
    output: parsed.data as DiagnosisOutput,
    strategy: repaired.strategy,
    repaired: repaired.repaired,
  };
}

/**
 * Formatted for a model to act on, not for a developer to read: field path,
 * what was wrong, capped so the retry prompt stays small.
 */
function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  const lines = issues.slice(0, 8).map((issue) => {
    const path = issue.path.map(String).join('.') || '(root)';
    return `- ${path}: ${issue.message}`;
  });
  const extra = issues.length > 8 ? `\n- ...and ${issues.length - 8} more` : '';
  return `The JSON parsed but did not match the required shape:\n${lines.join('\n')}${extra}`;
}
