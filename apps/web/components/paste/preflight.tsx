'use client';

import { useMemo } from 'react';

/**
 * Facts about the document in the box, computed locally.
 *
 * THE LINE THIS MUST NOT CROSS: these are OBSERVATIONS, never PREDICTIONS. It is
 * tempting to guess — "no numbers anywhere, so Success metrics will score low" —
 * and it would be wrong often enough to matter. A local heuristic that guesses
 * "Audience: probably low" and is then contradicted by the real score destroys
 * confidence in both numbers, and the real one is the one that took a model call.
 *
 * So every line here is checkable by looking at the text, and none of them implies
 * a score. "Contains no dates or figures" is a fact. "Will score badly on
 * metrics" is a guess wearing a fact's clothes.
 */

export interface Observation {
  label: string;
  /** Absent when there is nothing worth saying about that property. */
  detail?: string;
}

function observe(text: string): Observation[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const words = trimmed.split(/\s+/).filter(Boolean).length;
  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
  const lines = trimmed.split('\n').filter((l) => l.trim().length > 0);

  // A heading here means a short line that is not a sentence — a label, in other
  // words. Deliberately crude; it only ever reports what it found.
  const headings = lines.filter(
    (line) => line.trim().length <= 60 && !/[.!?]\s*$/.test(line.trim()),
  ).length;

  const hasNumbers = /\d/.test(trimmed);
  const hasDates =
    /\b\d{1,2}[/-]\d{1,2}\b|\b\d{4}\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i
      .test(trimmed);
  const hasMoney = /[£$€]\s?\d|\b\d+\s?(k|m)\b/i.test(trimmed);

  const out: Observation[] = [
    {
      label: `${words.toLocaleString()} word${words === 1 ? '' : 's'}`,
      detail: paragraphs > 1 ? `${paragraphs} paragraphs` : 'one unbroken block',
    },
  ];

  if (headings > 1) {
    out.push({ label: `${headings} section headings` });
  } else if (paragraphs > 2) {
    out.push({ label: 'No section headings' });
  }

  // Stated as presence or absence, with no consequence attached.
  out.push({
    label: hasNumbers ? 'Contains figures' : 'Contains no figures',
    ...(hasMoney ? { detail: 'including a budget figure' } : {}),
  });

  out.push({ label: hasDates ? 'Contains a date' : 'Contains no dates' });

  return out;
}

export function Preflight({ text }: { text: string }) {
  const observations = useMemo(() => observe(text), [text]);

  // Nothing worth saying about an almost-empty box, and a panel that appears on
  // the first keystroke is noise while someone is still pasting.
  if (text.trim().length < 120) return null;

  return (
    <section className="flex flex-col gap-2" aria-label="About this document">
      <p className="text-viz-muted text-xs">
        {/* Names the limit explicitly, so nobody reads the list as a preview of
            the score. */}
        What is in the box — not a prediction of the score.
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {observations.map((observation) => (
          <li key={observation.label} className="text-muted-foreground text-xs">
            {observation.label}
            {observation.detail ? (
              <span className="text-viz-muted"> · {observation.detail}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
