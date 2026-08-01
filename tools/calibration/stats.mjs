/**
 * Statistics for the Step 0 spike.
 *
 * The first block is what single-model mode uses. The second block — the
 * pairwise agreement statistics — is retained but currently unused: it is the
 * actual point of Step 0, and it becomes live again the moment a second model
 * is configured. It is provider-agnostic and carries no vendor dependency.
 */

export const THRESHOLDS = { READY: 80, NEEDS_WORK: 55 };

export function verdictOf(overall) {
  if (overall >= THRESHOLDS.READY) return 'READY';
  if (overall >= THRESHOLDS.NEEDS_WORK) return 'NEEDS_WORK';
  return 'NOT_READY';
}

/** Overall is computed HERE, in code, never read from the model. */
export function overallOf(dimensionScores) {
  const values = Object.values(dimensionScores);
  if (values.length === 0) return 0;
  return Math.round(values.reduce((a, b) => a + clamp(b), 0) / values.length);
}

export const clamp = (n) => Math.max(0, Math.min(100, Math.round(Number(n) || 0)));

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export function stdev(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

// ── pairwise agreement — dormant until a second model is configured ──────────

/** Mean absolute difference between two paired series. */
export const meanAbsDiff = (a, b) => mean(a.map((x, i) => Math.abs(x - b[i])));

export const maxAbsDiff = (a, b) => a.reduce((acc, x, i) => Math.max(acc, Math.abs(x - b[i])), 0);

/** Signed mean difference — whether one model is systematically kinder. */
export const meanSignedDiff = (a, b) => mean(a.map((x, i) => x - b[i]));

/** Average ranks; ties share the mean of the ranks they span. */
function rank(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const ranks = new Array(xs.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

/** Spearman rank correlation, tie-corrected via average ranks. */
export function spearman(a, b) {
  if (a.length < 2) return NaN;
  const ra = rank(a); const rb = rank(b);
  const ma = mean(ra); const mb = mean(rb);
  let num = 0; let da = 0; let db = 0;
  for (let i = 0; i < ra.length; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? NaN : num / den;
}

/** Kendall tau-b plus raw pair counts, which are easier to argue about. */
export function kendall(a, b) {
  let concordant = 0; let discordant = 0; let tiedA = 0; let tiedB = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = i + 1; j < a.length; j++) {
      const sa = Math.sign(a[i] - a[j]);
      const sb = Math.sign(b[i] - b[j]);
      if (sa === 0 && sb === 0) continue;
      if (sa === 0) tiedA++;
      else if (sb === 0) tiedB++;
      else if (sa === sb) concordant++;
      else discordant++;
    }
  }
  const den = Math.sqrt((concordant + discordant + tiedA) * (concordant + discordant + tiedB));
  return {
    tau: den === 0 ? NaN : (concordant - discordant) / den,
    concordant, discordant, tiedA, tiedB,
    comparablePairs: concordant + discordant,
    totalPairs: concordant + discordant + tiedA + tiedB,
  };
}

/** Fraction of briefs where both models land in the same shipping band. */
export function bandAgreement(overallA, overallB) {
  const rows = overallA.map((x, i) => [verdictOf(x), verdictOf(overallB[i])]);
  const agree = rows.filter(([x, y]) => x === y).length;
  return {
    agree, total: rows.length, rate: rows.length ? agree / rows.length : 0,
    disagreements: rows.map(([a, b], index) => ({ index, a, b })).filter((r) => r.a !== r.b),
  };
}
