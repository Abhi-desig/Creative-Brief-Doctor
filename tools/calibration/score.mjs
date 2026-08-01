#!/usr/bin/env node
/**
 * Step 0 calibration spike — Gemini only.
 *
 * Scores every brief in ./briefs against gemini-3.6-flash at the seed rubric
 * and reports score distribution, self-consistency, evidence health, rubric
 * compliance, and thinking-budget headroom.
 *
 * NOTE ON SCOPE: with one model this can no longer answer Step 0's original
 * question ("does the free tier agree with Opus closely enough to be the live
 * model?"). What it does answer is whether the RUBRIC is sound and whether
 * Gemini can execute it reliably — which is the other half of Step 0, and a
 * prerequisite for the comparison whenever a second model is added.
 *
 * Throwaway. Not application code, not in src/, key from env or the root .env.
 *
 *   node score.mjs
 *
 * Flags:
 *   --briefs <dir>            default ./briefs
 *   --out <dir>               default ./out
 *   --repeats <n>             runs per brief (default 1). >1 measures
 *                             self-consistency, which is the headline number
 *                             in single-model mode.
 *   --concurrency <n>         default 1. Free tier is 5 requests/min/model.
 *   --min-interval <ms>       default 13000, spaces request starts
 *   --model <id>              default gemini-3.6-flash
 *   --max-tokens <n>          default 16000
 *   --thinking-budget <n>     0 disables thinking on Flash; omit for AUTOMATIC
 *   --temperature <n>         omit for SDK default
 *   --fresh                   ignore cached runs in <out>/runs
 *   --plan                    show what is cached vs still to run, no API calls
 *   --dry-run                 count input tokens only, no generation
 *   --mock                    run the whole pipeline with a fake, no key needed
 *
 * The free-tier daily cap is 20 requests/day/model, so a 21-brief corpus spans
 * two days. Successful calls are cached and skipped on re-run; failures are not
 * cached, so re-running after the reset retries only what is missing.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { makeGemini, makeMock, GEMINI_SCHEMA } from './providers.mjs';
import { DIMENSIONS, ANCHORS } from './schema.mjs';
import { overallOf, verdictOf, clamp, mean, median, stdev } from './stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const RUBRIC_PATH = path.resolve(REPO_ROOT, 'apps/api/prisma/seed/rubric-v1.md');

// Pick up the root .env so the key lives in one place and never in a flag.
for (const envFile of [path.join(REPO_ROOT, '.env'), path.join(HERE, '.env')]) {
  try { process.loadEnvFile(envFile); } catch { /* absent is fine */ }
}

const args = parseArgs(process.argv.slice(2));
const OPT = {
  briefs: path.resolve(HERE, args.briefs ?? 'briefs'),
  out: path.resolve(HERE, args.out ?? 'out'),
  repeats: Number(args.repeats ?? 1),
  // Free tier is 5 requests per minute PER MODEL PER PROJECT (not 10, and not
  // per user). At ~13s a call, concurrency 1 sits just under that on its own.
  concurrency: Number(args.concurrency ?? 1),
  // gemini-2.5-flash — the model the design doc names — returns 404
  // "no longer available to new users" on a freshly issued key. It still
  // appears in models.list, so the list is not a safe availability check.
  model: args.model ?? 'gemini-3.6-flash',
  maxTokens: Number(args['max-tokens'] ?? 16000),
  thinkingBudget: args['thinking-budget'] !== undefined ? Number(args['thinking-budget']) : undefined,
  temperature: args.temperature !== undefined ? Number(args.temperature) : undefined,
  // One start every 13s keeps us under 5 requests/min with a margin.
  minInterval: Number(args['min-interval'] ?? 13_000),
  fresh: Boolean(args.fresh),
  dryRun: Boolean(args['dry-run']),
  mock: Boolean(args.mock),
  plan: Boolean(args.plan),
};

let results_done = 0;
const firstLine = (s) => {
  const t = String(s);
  try {
    const p = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
    if (p?.error?.message) return `${p.error.code ?? ''} ${String(p.error.message).split('\n')[0].slice(0, 90)}`.trim();
  } catch { /* not JSON */ }
  return t.split('\n')[0].slice(0, 100);
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n  FAILED  ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}

async function main() {
  const rubric = await readRubric();
  const briefs = await readBriefs(OPT.briefs);
  const provider = buildProvider();

  await fs.mkdir(path.join(OPT.out, 'runs'), { recursive: true });

  console.log(`\n  Calibration spike — single model`);
  console.log(`  rubric      apps/api/prisma/seed/rubric-v1.md  (sha256 ${rubric.hash.slice(0, 12)}, ${rubric.chars} chars)`);
  console.log(`  briefs      ${briefs.length}  from ${short(OPT.briefs)}`);
  console.log(`  model       ${provider.model}`);
  console.log(`  repeats     ${OPT.repeats}   concurrency ${OPT.concurrency}   maxTokens ${OPT.maxTokens}`);
  if (OPT.thinkingBudget !== undefined) console.log(`  thinkingBudget ${OPT.thinkingBudget}`);
  if (OPT.temperature !== undefined) console.log(`  temperature    ${OPT.temperature}`);
  console.log();

  const corpus = corpusHealth(briefs);
  if (corpus.warnings.length) {
    console.log('  CORPUS WARNING');
    for (const w of corpus.warnings) for (const l of wrap(w, 74)) console.log(`    ${l}`);
    console.log();
  }

  if (OPT.dryRun) return dryRun(provider, rubric, briefs);

  const jobs = [];
  for (const brief of briefs) for (let r = 1; r <= OPT.repeats; r++) jobs.push({ brief, repeat: r });

  if (OPT.plan) return plan(jobs, rubric, provider.model);

  if (!OPT.mock) {
    const secs = Math.round((jobs.length * Math.max(OPT.minInterval, 13_000)) / 1000);
    console.log(`  ${jobs.length} calls, paced at one start every ${(OPT.minInterval / 1000).toFixed(0)}s`
      + ` (free tier is 5/min/model). Expect roughly ${Math.floor(secs / 60)}m ${secs % 60}s.`);
    console.log(`  Results are cached per call, so interrupting and re-running resumes.\n`);
  }

  const pacer = makePacer(OPT.mock ? 0 : OPT.minInterval);
  const startedAll = Date.now();

  const results = await runPool(jobs, OPT.concurrency, async (job, n, pace) => {
    const cacheFile = cachePathFor(job, rubric, provider.model);

    if (!OPT.fresh) {
      const cached = await readJson(cacheFile);
      // Only successes are worth resuming. A cached failure — a 429, a dead
      // model — must be retried, or re-running after a quota reset would just
      // replay the same errors and --fresh would be the only option, throwing
      // away the successful calls too.
      if (cached?.ok) {
        results_done++;
        process.stdout.write(`  [${pad(n, jobs.length)}] cached  ${job.brief.id}\n`);
        return cached;
      }
    }

    await pace();
    let record;
    try {
      const res = await withRetry(() => provider.score({ system: rubric.text, user: job.brief.text }));
      record = buildRecord(job, res, rubric, provider);
    } catch (err) {
      record = {
        briefId: job.brief.id, model: provider.model, repeat: job.repeat, ok: false,
        error: String(err?.message ?? err), stopReason: null, scores: null,
        overall: null, verdict: null, usage: null, latencyMs: null,
        providerRequestId: null, degradations: ['request_failed'], issues: ['request_failed'],
      };
    }

    // Successes go in the resume cache; failures are written to a separate
    // name so they are inspectable but never resumed as if they were results.
    await fs.writeFile(
      record.ok ? cacheFile : cacheFile.replace(/\.json$/, '.failed.json'),
      JSON.stringify(record, null, 2),
    );
    const done = results_done++;
    const elapsed = (Date.now() - startedAll) / 1000;
    const eta = done > 0 ? Math.round((elapsed / done) * (jobs.length - done)) : null;
    const tag = record.ok
      ? `overall ${String(record.overall).padStart(3)}  ${record.verdict.padEnd(10)} ${record.stopReason}`
      : `ERROR  ${firstLine(record.error ?? record.issues.join(','))}`;
    process.stdout.write(`  [${pad(n, jobs.length)}] ${job.brief.id.padEnd(28)} ${tag}`
      + `${eta != null ? `   ~${eta}s left` : ''}\n`);
    return record;
  }, pacer);

  await report(results, briefs, provider, rubric, corpus);
}

// ── inputs ───────────────────────────────────────────────────────────────────

async function readRubric() {
  let text;
  try { text = await fs.readFile(RUBRIC_PATH, 'utf8'); }
  catch { throw new Error(`rubric not found at ${RUBRIC_PATH}`); }
  // The file IS the prompt, byte for byte. Nothing is interpolated into it and
  // nothing is stripped, so this hash is the one that goes in the database.
  return { text, chars: text.length, hash: createHash('sha256').update(text, 'utf8').digest('hex') };
}

async function readBriefs(dir) {
  let entries;
  try { entries = await fs.readdir(dir); }
  catch { throw new Error(`briefs directory not found: ${dir}`); }
  const files = entries
    .filter((f) => /\.(md|txt)$/i.test(f))
    .filter((f) => !f.startsWith('.'))
    .filter((f) => !/^readme\.(md|txt)$/i.test(f))
    .sort(natural);
  if (files.length === 0) {
    throw new Error(
      `no briefs in ${dir}\n\n`
      + `  Drop one file per brief (.md or .txt) into that directory and re-run.\n`
      + `  The filename becomes the brief id in the CSV.`,
    );
  }
  const briefs = [];
  for (const f of files) {
    const text = (await fs.readFile(path.join(dir, f), 'utf8')).trim();
    if (!text) { console.warn(`  skipping empty brief: ${f}`); continue; }
    briefs.push({ id: path.basename(f).replace(/\.(md|txt)$/i, ''), file: f, text, chars: text.length });
  }
  return briefs;
}

/**
 * A spread measurement is only meaningful over briefs that actually differ in
 * quality. Near-identical briefs produce near-identical scores, which reads as
 * "the rubric is stable" when it in fact measures nothing. Detect that here
 * rather than letting it pass as a green light.
 */
function corpusHealth(briefs) {
  const warnings = [];
  const skeleton = (t) => t.replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().toLowerCase();
  const groups = new Map();
  for (const b of briefs) {
    const k = skeleton(b.text);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b.id);
  }
  const clones = [...groups.values()].filter((g) => g.length > 1);
  const distinct = groups.size;

  if (clones.length) {
    const biggest = clones.sort((a, b) => b.length - a.length)[0];
    warnings.push(
      `${briefs.length} brief file(s) reduce to only ${distinct} distinct template(s) once digits `
      + `are normalised. The largest group has ${biggest.length} members `
      + `(${biggest.slice(0, 3).join(', ')}${biggest.length > 3 ? ', ...' : ''}). `
      + 'Briefs that differ only by a substituted number have identical quality, so they cannot '
      + 'produce a score spread, an ordering, or a meaningful agreement statistic. Any variance '
      + 'you see across them is model noise, not discrimination.',
    );
  }
  const lengths = briefs.map((b) => b.chars);
  if (briefs.length > 3 && stdev(lengths) / Math.max(1, mean(lengths)) < 0.1) {
    warnings.push(
      `Brief lengths are near-uniform (mean ${Math.round(mean(lengths))} chars, stdev `
      + `${stdev(lengths).toFixed(0)}). Real corpora vary widely; a uniform one usually means `
      + 'generated fixtures rather than briefs people actually sent.',
    );
  }
  return { warnings, distinct, clones };
}

function buildProvider() {
  if (OPT.mock) return makeMock({ key: 'gemini', jitter: 20 });
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is not set.\n\n'
      + `  Add it to ${path.join(REPO_ROOT, '.env')} as:\n`
      + '    GEMINI_API_KEY=...\n\n'
      + '  Or run with --mock to exercise the pipeline without a key.',
    );
  }
  return makeGemini({
    apiKey, model: OPT.model, maxTokens: OPT.maxTokens,
    thinkingBudget: OPT.thinkingBudget, temperature: OPT.temperature,
  });
}

// ── per-run validation ───────────────────────────────────────────────────────

export function buildRecord(job, res, rubric, provider) {
  const issues = [];
  const out = res.output;

  if (res.stopReason !== 'complete') issues.push(`stop_${res.stopReason}`);
  if (!out) {
    return {
      briefId: job.brief.id, model: provider?.model ?? null, repeat: job.repeat, ok: false,
      stopReason: res.stopReason, scores: null, overall: null, verdict: null,
      usage: res.usage, latencyMs: res.latencyMs, providerRequestId: res.providerRequestId,
      degradations: res.degradations, issues: [...issues, 'no_output'], rubricHash: rubric.hash,
    };
  }

  // The model must not have computed a total. Constitution principle 2.
  for (const forbidden of ['overall', 'overallScore', 'total', 'totalScore', 'verdict', 'score']) {
    if (Object.prototype.hasOwnProperty.call(out, forbidden)) issues.push(`model_emitted_${forbidden}`);
  }
  if (/\b(\d{1,3})\s*(?:\/\s*100|out of 100|%)/i.test(out.summary ?? '')) {
    issues.push('summary_contains_score');
  }

  const scores = {};
  const evidence = {};
  for (const d of DIMENSIONS) {
    const node = out.dimensions?.[d];
    if (!node) { issues.push(`missing_dimension_${d}`); scores[d] = 0; evidence[d] = []; continue; }
    const raw = Number(node.score);
    if (!ANCHORS.includes(raw)) issues.push(`off_anchor_${d}_${node.score}`);
    scores[d] = clamp(raw); // clamp unconditionally; no provider guarantees the range
    evidence[d] = Array.isArray(node.evidence) ? node.evidence : [];
  }

  // Evidence health. A score with no traceable quote is not defensible, and a
  // quote that is not actually in the brief is worse than no quote at all.
  const haystack = normalise(job.brief.text);
  let scoredDims = 0; let withEvidence = 0; let quotesTotal = 0; let quotesVerbatim = 0;
  const fabricated = [];
  for (const d of DIMENSIONS) {
    if (scores[d] > 0) { scoredDims++; if (evidence[d].length > 0) withEvidence++; }
    for (const q of evidence[d]) {
      quotesTotal++;
      if (typeof q === 'string' && q.trim() && haystack.includes(normalise(q))) quotesVerbatim++;
      else fabricated.push(`${d}: ${String(q).slice(0, 60)}`);
    }
  }
  if (scoredDims > 0 && withEvidence < scoredDims) issues.push('missing_evidence');
  if (fabricated.length) issues.push('fabricated_quote');

  const questions = Array.isArray(out.questions) ? out.questions : [];
  if (questions.length < 3 || questions.length > 8) issues.push(`question_count_${questions.length}`);
  const ranks = questions.map((q) => q.rank).sort((a, b) => a - b);
  if (ranks.some((r, i) => r !== i + 1)) issues.push('question_ranks_not_consecutive');
  if (questions.some((q) => !DIMENSIONS.includes(q.dimension))) issues.push('question_bad_dimension');

  const overall = overallOf(scores); // computed here, in code

  return {
    briefId: job.brief.id, model: provider?.model ?? null, repeat: job.repeat, ok: true,
    stopReason: res.stopReason, scores, overall, verdict: verdictOf(overall),
    summary: out.summary ?? '',
    questionCount: questions.length,
    blockingQuestions: questions.filter((q) => q.blocking === true).length,
    evidence: { scoredDims, withEvidence, quotesTotal, quotesVerbatim, fabricated },
    usage: res.usage, latencyMs: res.latencyMs, providerRequestId: res.providerRequestId,
    degradations: res.degradations, issues, rubricHash: rubric.hash,
  };
}

const normalise = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/\s+/g, ' ').trim().toLowerCase();

// ── reporting ────────────────────────────────────────────────────────────────

async function report(results, briefs, provider, rubric, corpus) {
  const ok = results.filter((r) => r.ok);
  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };

  // Median across repeats, so one bad run does not distort the picture.
  const perBrief = briefs.map((b) => {
    const runs = ok.filter((r) => r.briefId === b.id);
    if (!runs.length) return null;
    const scores = {};
    for (const d of DIMENSIONS) scores[d] = median(runs.map((r) => r.scores[d]));
    const overall = overallOf(scores);
    return {
      id: b.id, scores, overall, verdict: verdictOf(overall), runs,
      selfSpread: runs.length > 1 ? stdev(runs.map((r) => r.overall)) : null,
      selfRange: runs.length > 1 ? Math.max(...runs.map((r) => r.overall)) - Math.min(...runs.map((r) => r.overall)) : null,
    };
  }).filter(Boolean);

  await writeCsv(path.join(OPT.out, 'scores.csv'), scoresCsv(results));
  await writeCsv(path.join(OPT.out, 'per-brief.csv'), perBriefCsv(perBrief));

  say();
  say('  ' + '='.repeat(76));
  say('  RESULT');
  say('  ' + '='.repeat(76));
  say();

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    say(`  ${failed.length} of ${results.length} runs failed or returned no output:`);
    for (const f of failed.slice(0, 10)) say(`    ${f.briefId.padEnd(28)} ${f.error ?? f.issues.join(', ')}`);
    say();
  }
  if (!ok.length) { say('  Nothing to report.'); return finish(lines); }

  // 1. Score distribution — does the rubric discriminate at all?
  const overalls = perBrief.map((b) => b.overall);
  say(`  SCORE DISTRIBUTION  (${perBrief.length} briefs${OPT.repeats > 1 ? `, median of ${OPT.repeats} runs each` : ''})`);
  say(`    overall   mean ${mean(overalls).toFixed(1)}   median ${median(overalls)}   min ${Math.min(...overalls)}   max ${Math.max(...overalls)}   stdev ${stdev(overalls).toFixed(1)}`);
  say();
  for (const d of DIMENSIONS) {
    const xs = perBrief.map((b) => b.scores[d]);
    const hist = ANCHORS.map((a) => `${a}:${xs.filter((x) => x === a).length}`).join('  ');
    say(`    ${d.padEnd(22)} mean ${mean(xs).toFixed(1).padStart(5)}   ${hist}`);
  }
  say();
  const spread = Math.max(...overalls) - Math.min(...overalls);
  if (spread === 0) {
    say(`    Every brief scored identically (${overalls[0]}). Either the corpus has no quality`);
    say(`    variance or the rubric is not discriminating. Check the corpus warning above.`);
  } else {
    say(`    Overall range is ${spread} points. A rubric that discriminates should spread a`);
    say(`    mixed corpus across most of 0-100; a narrow range on a varied corpus means the`);
    say(`    anchors are too forgiving or too harsh.`);
  }
  say();

  // 2. Verdict distribution
  const bands = ['READY', 'NEEDS_WORK', 'NOT_READY'];
  say(`  VERDICT DISTRIBUTION  (>=80 READY, 55-79 NEEDS_WORK, <55 NOT_READY)`);
  for (const v of bands) {
    const n = perBrief.filter((b) => b.verdict === v).length;
    say(`    ${v.padEnd(12)} ${String(n).padStart(3)}  ${'#'.repeat(Math.round((n / perBrief.length) * 40))}`);
  }
  say();

  // 3. Self-consistency — the headline number in single-model mode
  if (OPT.repeats > 1) {
    const spreads = perBrief.map((b) => b.selfSpread).filter((x) => x != null);
    const ranges = perBrief.map((b) => b.selfRange).filter((x) => x != null);
    say(`  SELF-CONSISTENCY  (same brief, same prompt, ${OPT.repeats} runs)`);
    say(`    stdev of overall   mean ${mean(spreads).toFixed(1)}   max ${Math.max(...spreads).toFixed(1)}`);
    say(`    range of overall   mean ${mean(ranges).toFixed(1)}   max ${Math.max(...ranges)}`);
    const worst = [...perBrief].sort((a, b) => b.selfRange - a.selfRange).slice(0, 3);
    for (const w of worst) {
      if (w.selfRange > 0) say(`      ${w.id.padEnd(28)} ${w.runs.map((r) => r.overall).join(', ')}`);
    }
    say();
    say(`    This is the noise floor. Any future cross-model difference smaller than this`);
    say(`    is not a real difference. It is also what a user would see if they pasted the`);
    say(`    same brief twice, so it caps how defensible the number can ever be.`);
    say();
  } else {
    say(`  SELF-CONSISTENCY  not measured — re-run with --repeats 3.`);
    say(`    In single-model mode this is the most informative number available: it is both`);
    say(`    the noise floor for any later comparison and what a user sees on a re-paste.`);
    say();
  }

  // 4. Evidence health — a gate in its own right
  const cov = sumBy(ok, (r) => r.evidence.withEvidence) / Math.max(1, sumBy(ok, (r) => r.evidence.scoredDims));
  const fid = sumBy(ok, (r) => r.evidence.quotesVerbatim) / Math.max(1, sumBy(ok, (r) => r.evidence.quotesTotal));
  const badRuns = ok.filter((r) => r.issues.includes('fabricated_quote'));
  say(`  EVIDENCE HEALTH`);
  say(`    scored dimensions carrying a quote   ${(cov * 100).toFixed(0)}%`);
  say(`    quotes found verbatim in the brief   ${(fid * 100).toFixed(0)}%`);
  say(`    runs with a fabricated quote         ${badRuns.length} / ${ok.length}`);
  for (const r of badRuns.slice(0, 5)) {
    say(`      ${r.briefId.padEnd(24)} ${r.evidence.fabricated[0]}`);
  }
  if (cov < 0.95 || fid < 0.95) {
    say();
    say(`    BELOW THRESHOLD. A report whose quotes are not actually in the brief is not`);
    say(`    defensible to the stakeholder it exists to be sent to. Fix this before`);
    say(`    anything else — it is independent of the score spread.`);
  }
  say();

  // 5. Rubric compliance
  const emitted = ok.filter((r) => r.issues.some((i) => i.startsWith('model_emitted_') || i === 'summary_contains_score'));
  const offAnchor = ok.filter((r) => r.issues.some((i) => i.startsWith('off_anchor_')));
  const badQ = ok.filter((r) => r.issues.some((i) => i.startsWith('question_')));
  say(`  RUBRIC COMPLIANCE`);
  say(`    runs where the model computed a total    ${emitted.length} / ${ok.length}`);
  say(`    runs with an off-anchor score            ${offAnchor.length} / ${ok.length}`);
  say(`    runs with malformed questions            ${badQ.length} / ${ok.length}`);
  say(`    questions per run    mean ${mean(ok.map((r) => r.questionCount)).toFixed(1)}   blocking ${mean(ok.map((r) => r.blockingQuestions)).toFixed(1)}`);
  say();

  // 6. Thinking budget headroom — the Gemini-specific trap
  const withUsage = ok.filter((r) => r.usage);
  if (withUsage.length) {
    const worst = withUsage.reduce((a, r) =>
      (r.usage.outputTokens + r.usage.reasoningTokens) > (a.usage.outputTokens + a.usage.reasoningTokens) ? r : a);
    const worstTotal = worst.usage.outputTokens + worst.usage.reasoningTokens;
    say(`  TOKENS & THINKING BUDGET  (maxOutputTokens ${OPT.maxTokens})`);
    say(`    input    mean ${Math.round(mean(withUsage.map((r) => r.usage.inputTokens)))}`);
    say(`    output   mean ${Math.round(mean(withUsage.map((r) => r.usage.outputTokens)))}`);
    say(`    thinking mean ${Math.round(mean(withUsage.map((r) => r.usage.reasoningTokens)))}   max ${Math.max(...withUsage.map((r) => r.usage.reasoningTokens))}`);
    say(`    worst case output+thinking  ${worstTotal} / ${OPT.maxTokens}  (${((worstTotal / OPT.maxTokens) * 100).toFixed(0)}% of budget, ${worst.briefId})`);
    const truncated = ok.filter((r) => r.stopReason === 'max_tokens').length;
    say(`    runs truncated at max_tokens             ${truncated} / ${ok.length}`);
    if (worstTotal > OPT.maxTokens * 0.8) {
      say(`    OVER 80% OF BUDGET. Thinking is on by default and eats maxOutputTokens`);
      say(`    alongside the JSON. Raise --max-tokens or set --thinking-budget.`);
    }
    say(`    latency  mean ${Math.round(mean(withUsage.map((r) => r.latencyMs)))}ms   max ${Math.max(...withUsage.map((r) => r.latencyMs))}ms`);
    say();
  }

  // 7. What this run can and cannot conclude
  say('  ' + '-'.repeat(76));
  say('  WHAT THIS DOES AND DOES NOT ESTABLISH');
  say('  ' + '-'.repeat(76));
  const canSay = [];
  const cannotSay = [];
  (fid >= 0.95 && cov >= 0.95 ? canSay : cannotSay).push('Gemini quotes evidence faithfully from the brief.');
  (offAnchor.length === 0 ? canSay : cannotSay).push('Gemini respects the discrete anchor scale.');
  (emitted.length === 0 ? canSay : cannotSay).push('Gemini does not compute the total itself.');
  if (OPT.repeats > 1) canSay.push(`Gemini's own noise floor is about ${mean(perBrief.map((b) => b.selfSpread).filter((x) => x != null)).toFixed(1)} points.`);
  else cannotSay.push("Gemini's run-to-run stability (needs --repeats 3).");
  if (corpus.clones.length || spread === 0) {
    cannotSay.push('Whether the rubric discriminates between good and bad briefs — the corpus lacks quality variance.');
  } else canSay.push('The rubric spreads this corpus across a usable range.');
  cannotSay.push('Whether the absolute number is defensible — that needs a second model to compare against.');

  if (canSay.length) { say('  Established:'); for (const s of canSay) for (const l of wrap('- ' + s, 72)) say(`    ${l}`); }
  if (cannotSay.length) { say(); say('  NOT established:'); for (const s of cannotSay) for (const l of wrap('- ' + s, 72)) say(`    ${l}`); }
  say();
  for (const f of ['scores.csv', 'per-brief.csv', 'report.txt']) {
    say(`  ${f === 'scores.csv' ? 'Wrote ' : '      '} ${short(path.join(OPT.out, f))}`);
  }
  say();

  return finish(lines);

  async function finish(ls) {
    await fs.writeFile(path.join(OPT.out, 'report.txt'), ls.join('\n') + '\n');
    await fs.writeFile(path.join(OPT.out, 'meta.json'), JSON.stringify({
      rubricHash: rubric.hash, rubricChars: rubric.chars, model: provider.model,
      options: OPT, briefCount: briefs.length, runCount: results.length,
      corpus: { distinctTemplates: corpus.distinct, cloneGroups: corpus.clones },
      geminiSchema: GEMINI_SCHEMA,
    }, null, 2));
  }
}

function scoresCsv(results) {
  const head = ['brief_id', 'model', 'repeat', 'ok', 'stop_reason',
    ...DIMENSIONS.map((d) => d.toLowerCase()), 'overall', 'verdict',
    'questions', 'blocking_questions', 'quotes_total', 'quotes_verbatim',
    'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens',
    'latency_ms', 'degradations', 'issues', 'provider_request_id'];
  const rows = results.map((r) => [
    r.briefId, r.model ?? '', r.repeat, r.ok, r.stopReason ?? '',
    ...DIMENSIONS.map((d) => r.scores?.[d] ?? ''),
    r.overall ?? '', r.verdict ?? '', r.questionCount ?? '', r.blockingQuestions ?? '',
    r.evidence?.quotesTotal ?? '', r.evidence?.quotesVerbatim ?? '',
    r.usage?.inputTokens ?? '', r.usage?.outputTokens ?? '',
    r.usage?.reasoningTokens ?? '', r.usage?.cachedReadTokens ?? '',
    r.latencyMs ?? '', (r.degradations ?? []).join('|'), (r.issues ?? []).join('|'),
    r.providerRequestId ?? '',
  ]);
  return [head, ...rows];
}

function perBriefCsv(perBrief) {
  const head = ['brief_id', ...DIMENSIONS.map((d) => d.toLowerCase()),
    'overall', 'verdict', 'self_stdev', 'self_range'];
  const rows = perBrief.map((b) => [b.id, ...DIMENSIONS.map((d) => b.scores[d]),
    b.overall, b.verdict, b.selfSpread?.toFixed(2) ?? '', b.selfRange ?? '']);
  return [head, ...rows];
}

// ── plumbing ─────────────────────────────────────────────────────────────────

/**
 * Resume plan. No API calls, so it is safe to check while quota is exhausted.
 * Exists because the free-tier daily cap forces a multi-day run.
 */
async function plan(jobs, rubric, model) {
  const done = []; const todo = [];
  for (const job of jobs) {
    const cached = await readJson(cachePathFor(job, rubric, model));
    (cached?.ok ? done : todo).push(job);
  }
  console.log(`  RESUME PLAN  (no API calls made)\n`);
  console.log(`  cached and complete   ${done.length} / ${jobs.length}`);
  console.log(`  still to run          ${todo.length}\n`);
  if (done.length) {
    console.log('  done:');
    for (const j of done) console.log(`    ${j.brief.id}${OPT.repeats > 1 ? `  r${j.repeat}` : ''}`);
    console.log();
  }
  if (todo.length) {
    console.log('  to run:');
    for (const j of todo) console.log(`    ${j.brief.id}${OPT.repeats > 1 ? `  r${j.repeat}` : ''}`);
    console.log();
    const days = Math.ceil(todo.length / 20);
    console.log(`  At the free-tier cap of 20 requests/day/model that is ${days} more day(s).`);
    console.log(`  Re-run \`node score.mjs\` after the quota resets (midnight Pacific);`);
    console.log(`  cached successes are skipped automatically.\n`);
  } else {
    console.log('  Nothing left to run. `node score.mjs` will report from cache.\n');
  }
}

async function dryRun(provider, rubric, briefs) {
  console.log('  DRY RUN — counting input tokens only, no generation.\n');
  let total = 0;
  for (const b of briefs) {
    const { tokens } = await provider.countInputTokens({ system: rubric.text, user: b.text });
    total += tokens;
    console.log(`  ${b.id.padEnd(28)} ${String(tokens).padStart(6)} input tokens`);
  }
  console.log(`\n  TOTAL ${String(total * OPT.repeats).padStart(28)} input tokens across ${briefs.length * OPT.repeats} calls`);
  console.log('  Re-run without --dry-run to score.\n');
}

/**
 * Spaces request STARTS so we stay under the quota rather than discovering it.
 * Free tier is 5 requests per minute per model per project, so the floor is one
 * start every 12s. Backing off after a 429 also works but wastes ~53s each
 * time, which is what made the first attempt unusable.
 */
function makePacer(minIntervalMs) {
  let next = 0;
  return async function pace() {
    if (minIntervalMs <= 0) return;
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minIntervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  };
}

async function runPool(jobs, limit, worker, pace = async () => {}) {
  const results = new Array(jobs.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (cursor < jobs.length) {
      const i = cursor++;
      results[i] = await worker(jobs[i], i + 1, pace);
    }
  }));
  return results;
}

/**
 * The free tier returns a precise RetryInfo — "please retry in 53s" — and
 * ignoring it in favour of exponential backoff guarantees every retry also
 * fails. Honour the server's number when it gives one.
 */
function retryAfterMs(err) {
  const msg = String(err?.message ?? '');
  try {
    const parsed = JSON.parse(msg.slice(msg.indexOf('{'), msg.lastIndexOf('}') + 1));
    const info = parsed?.error?.details?.find((d) => String(d['@type']).endsWith('RetryInfo'));
    const secs = parseFloat(String(info?.retryDelay ?? '').replace('s', ''));
    if (Number.isFinite(secs) && secs > 0) return secs * 1000;
  } catch { /* fall through to the text form */ }
  const m = msg.match(/retry in ([\d.]+)\s*s/i);
  return m ? parseFloat(m[1]) * 1000 : null;
}

/**
 * A 429 can be either the per-minute rate limit or the per-day cap, and they
 * need opposite handling. Google returns a ~58s RetryInfo for BOTH, so obeying
 * it on a daily exhaustion means retrying for hours against a quota that will
 * not reset until midnight Pacific. Distinguish on quotaId.
 *
 * This is exactly the distinction the error taxonomy separates as
 * `rate_limit` (retryable, 503 "scoring is busy") and `quota_exhausted`
 * (terminal for today, 503 with a different message and a different remedy).
 */
function quotaKind(err) {
  const msg = String(err?.message ?? '');
  if (/PerDayPerProject|RequestsPerDay/i.test(msg)) return 'quota_exhausted';
  if (/PerMinutePerProject|RequestsPerMinute/i.test(msg)) return 'rate_limit';
  return null;
}

function quotaLimit(err) {
  const m = String(err?.message ?? '').match(/limit:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

async function withRetry(fn, attempts = 5) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.response?.status;
      const msg = String(err?.message ?? '');
      // A model that is gone stays gone; retrying wastes quota on a 404.
      if (status === 404 || /not available|NOT_FOUND/i.test(msg)) throw err;
      // The daily cap will not reset for hours. Fail fast and loudly instead of
      // sleeping through a RetryInfo that does not apply.
      if (quotaKind(err) === 'quota_exhausted') {
        const lim = quotaLimit(err);
        const e = new Error(
          `quota_exhausted: daily free-tier cap reached for ${OPT.model}`
          + `${lim ? ` (limit ${lim} requests/day/model)` : ''}. `
          + 'This does not reset in seconds — it resets at midnight Pacific. '
          + 'Not retrying.',
        );
        e.kind = 'quota_exhausted';
        throw e;
      }
      const retryable = status === 429 || status === 503 || status === 529
        || (status >= 500 && status < 600)
        || /rate.?limit|overloaded|RESOURCE_EXHAUSTED|ECONNRESET|ETIMEDOUT/i.test(msg);
      if (!retryable || i === attempts - 1) throw err;
      // Server's number first, +2s of slack, then exponential as the fallback.
      const advised = retryAfterMs(err);
      const wait = advised != null
        ? Math.min(90_000, advised + 2000)
        : Math.min(60_000, 2000 * 2 ** i) + Math.random() * 1000;
      process.stdout.write(`      rate limited, waiting ${(wait / 1000).toFixed(0)}s (attempt ${i + 1}/${attempts - 1})\n`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

async function writeCsv(file, rows) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  await fs.writeFile(file, rows.map((r) => r.map(esc).join(',')).join('\n') + '\n');
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return null; }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

/**
 * Cache identity is (brief, model, repeat, rubric hash). The MODEL is part of
 * the key deliberately: a score is only meaningful for the model that produced
 * it, so switching model must not reuse the old record — and it stops a --mock
 * run from writing fake records into a real run's namespace, which is exactly
 * the accident this key prevents.
 */
function cachePathFor(job, rubric, model) {
  const key = `${job.brief.id}__${model}__r${job.repeat}__${rubric.hash.slice(0, 8)}`;
  return path.join(OPT.out, 'runs', `${sanitise(key)}.json`);
}

const sumBy = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
const pad = (n, total) => String(n).padStart(String(total).length);
const sanitise = (s) => s.replace(/[^a-zA-Z0-9._-]/g, '_');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const short = (p) => {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith('..') ? p : rel;
};
const wrap = (s, w) => s.split(' ').reduce((ls, word) => {
  if (!ls.length || (ls[ls.length - 1] + ' ' + word).length > w) ls.push(word);
  else ls[ls.length - 1] += ' ' + word;
  return ls;
}, []);
