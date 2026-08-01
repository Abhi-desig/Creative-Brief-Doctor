import { describe, expect, it } from 'vitest';
import { observe } from './preflight';

/**
 * Pre-flight observations.
 *
 * The constraint under test is a PRODUCT one, not a formatting one: every line
 * must be a checkable fact about the text, and none may imply a score. A local
 * heuristic that guesses "Audience: probably low" and is then contradicted by the
 * real score destroys confidence in both numbers — and the real one is the one
 * that cost a model call.
 */

const labels = (text: string) => observe(text).map((o) => o.label);

describe('observe', () => {
  it('says nothing about an empty document', () => {
    expect(observe('')).toEqual([]);
    expect(observe('   \n  ')).toEqual([]);
  });

  it('counts words and paragraphs', () => {
    const out = observe('One two three.\n\nFour five six.');
    expect(out[0]!.label).toBe('6 words');
    expect(out[0]!.detail).toBe('2 paragraphs');
  });

  it('names a single unbroken block as such', () => {
    // The shape that matters: a wall of text with no structure.
    const out = observe('word '.repeat(60));
    expect(out[0]!.detail).toBe('one unbroken block');
  });

  it('reports the presence and absence of figures', () => {
    expect(labels('We need 5,000 signups.')).toContain('Contains figures');
    expect(labels('We need lots of signups.')).toContain('Contains no figures');
  });

  it('notes a budget figure as a detail rather than a verdict', () => {
    const money = observe('Budget is £12k for this.').find((o) => o.label === 'Contains figures');
    expect(money?.detail).toBe('including a budget figure');
  });

  it('reports the presence and absence of dates', () => {
    expect(labels('Live by 14 August.')).toContain('Contains a date');
    expect(labels('Live by end of month ideally.')).toContain('Contains no dates');
  });

  it('NEVER implies a score, a grade or a dimension outcome', () => {
    /**
     * The load-bearing assertion. If someone later adds "Audience: probably low"
     * this fails, and it should — that is a prediction wearing a fact's clothes,
     * and it will disagree with the real score often enough to matter.
     */
    const samples = [
      'hey can you do a video? thanks',
      'Objective: recover lapsed subscribers by 4 August. Budget £12k. Target 6%.',
      'word '.repeat(200),
    ];
    const forbidden = [
      'score', 'likely', 'probably', 'expect', 'predict', 'weak', 'strong',
      'poor', 'good', 'bad', 'low', 'high', 'ready', 'objective clarity',
      'audience', 'metrics',
    ];

    for (const sample of samples) {
      for (const observation of observe(sample)) {
        const text = `${observation.label} ${observation.detail ?? ''}`.toLowerCase();
        for (const word of forbidden) {
          expect(text, `"${observation.label}" must not imply "${word}"`).not.toContain(word);
        }
      }
    }
  });

  it('describes only properties a reader could verify by looking', () => {
    // Every observation is about length, structure, or the presence of a token
    // type — never about meaning.
    for (const o of observe('Rebrand brief\n\nWe need something modern and bold.')) {
      expect(o.label).toMatch(/words?|headings?|figures?|dates?/i);
    }
  });
});
