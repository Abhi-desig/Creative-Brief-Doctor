# Step 0 — calibration spike (Gemini only)

Throwaway. Not application code, not in `src/`, key read from the root `.env`.

## What it measures now

The original Step 0 question was cross-model: *do `gemini-2.5-flash` and
`claude-opus-5` agree closely enough for the free tier to be the live model?*
With Anthropic removed there is no second model, so that question is out of
reach. What this answers instead is the other half of Step 0:

- **Does the rubric discriminate?** Score distribution across a mixed corpus.
- **Is the evidence trustworthy?** Every quote is checked for appearing
  *verbatim* in the source brief. A fabricated quote is the one failure that
  makes a report indefensible to a stakeholder who checks.
- **Does the model obey the rubric?** Anchor compliance, and whether it
  computed a total it was told not to compute.
- **Is the thinking budget safe?** Thinking is on by default and eats
  `maxOutputTokens` alongside the JSON.
- **How stable is it?** With `--repeats > 1`, run-to-run variance — the noise
  floor any future comparison has to clear, and what a user sees on a re-paste.

The pairwise agreement statistics in `stats.mjs` are retained and dormant; they
go live again the moment a second model is configured.

## Setup

```bash
npm install
```

The key comes from `GEMINI_API_KEY` in the repo-root `.env`. Nothing is passed
on the command line.

Briefs live in `briefs/`, one file per brief (`.md` or `.txt`). The filename
becomes the brief id. Contents are git-ignored.

## Run

```bash
node score.mjs --mock         # whole pipeline, no key, no quota
node score.mjs --dry-run      # count input tokens only
node score.mjs                # the real run
node score.mjs --repeats 3    # adds self-consistency
```

Successful calls are cached under `out/runs/` keyed by brief and rubric hash.
Failures are written alongside as `*.failed.json` and are **not** resumed, so
re-running after a quota reset retries only what failed. Editing the rubric
changes the hash and invalidates the cache by design. `--fresh` forces
everything.

Flags: `--model` (default `gemini-3.6-flash`), `--concurrency` (default 1),
`--min-interval` (default 13000ms), `--max-tokens` (default 16000),
`--thinking-budget` (0 disables thinking), `--temperature`.

## Free-tier limits, measured on a real key

Both of these contradict assumptions in the design doc and are worth knowing
before planning a run:

| Limit | Value | Notes |
| --- | --- | --- |
| Requests per minute | **5** per model per project | Not 10, and not per user. |
| Requests per **day** | **20** per model per project | This is the binding constraint. |

A 21-brief corpus does not fit in one day on one model. `--repeats 3` needs 63
calls, which is over three days.

Two traps this creates:

1. **Google returns a ~58s `RetryInfo` for the per-day cap as well as the
   per-minute one.** Obeying it on a daily exhaustion means retrying for hours
   against a quota that resets at midnight Pacific. The script distinguishes
   the two on `quotaId` and refuses to retry the daily one — the same
   `rate_limit` vs `quota_exhausted` split the error taxonomy calls for.
2. **The daily quota is per model.** Switching model gets a fresh allowance,
   but a calibration run is only meaningful if every brief is scored by the
   *same* model, so this is not a way around the cap.

## Other findings worth carrying into `packages/ai`

- **`gemini-2.5-flash` returns 404 "no longer available to new users"** on a
  freshly issued key, while still appearing in `models.list()`. The list
  endpoint is not a safe availability check — probe with a real call.
- **`countTokens` rejects `systemInstruction`** on the Developer API (AI Studio
  keys); it is Vertex/Enterprise only. To count the bytes actually sent, fold
  the system text into `contents`. The admission gate's "exact native count" is
  therefore approximate at the margin, so keep the ceiling below the hard limit
  rather than exactly at it.
- **Thinking runs roughly 3.4x the size of the JSON output** on
  `gemini-3.6-flash` at this rubric — mean 3,470 thinking tokens against 1,017
  output. A budget sized for "just the JSON" truncates.
- **Latency is 22s mean, 33s worst** at this prompt size. That is the number
  the SSE keepalive and any request timeout have to accommodate.

## Output

| File | What it is |
| --- | --- |
| `out/scores.csv` | One row per run: dimensions, overall, verdict, tokens, latency, degradations, validation issues. |
| `out/per-brief.csv` | One row per brief, median across repeats, with self-consistency columns. |
| `out/report.txt` | The printed summary. |
| `out/meta.json` | Rubric hash, options, corpus health, compiled Gemini schema. |
| `out/runs/*.json` | Raw successful records (the resume cache). |

The report ends with an explicit *established / not established* split, so a
partial or single-model run cannot be misread as a full green light.

## Corpus health

A spread measurement is only meaningful over briefs that differ in quality. The
script normalises digits and warns when files collapse to a small number of
templates, or when lengths are suspiciously uniform — both of which produce
identical scores that read as stability while measuring nothing.
