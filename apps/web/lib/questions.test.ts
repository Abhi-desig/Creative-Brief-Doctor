import { describe, expect, it } from 'vitest';
import { buildMessage, buildPlainText, canonicalise, type QuestionRow } from './questions';

/**
 * The report's question numbering.
 *
 * This is the logic that was actually broken: one question carried three
 * different numbers on a single page, across the list, the copied text and the
 * ready-to-send message. Since those numbers exist so that two colleagues can say
 * "can you answer 4?" over email, disagreement between them defeats the feature
 * entirely.
 */

const q = (over: Partial<QuestionRow> & { question: string }): QuestionRow => ({
  dimension: 'OBJECTIVE_CLARITY',
  blocking: false,
  rank: 1,
  ...over,
});

describe('canonicalise', () => {
  it('numbers consecutively from 1 regardless of the model\'s ranks', () => {
    // A model that emitted 3, 7, 11 rather than 1, 2, 3 — the rubric ASKS for
    // consecutive ranks in prose, which is a request, not a constraint.
    const out = canonicalise([
      q({ question: 'c', rank: 11 }),
      q({ question: 'a', rank: 3 }),
      q({ question: 'b', rank: 7 }),
    ]);
    expect(out.map((x) => x.n)).toEqual([1, 2, 3]);
    expect(out.map((x) => x.question)).toEqual(['a', 'b', 'c']);
  });

  it('puts blocking questions first, preserving rank within each group', () => {
    const out = canonicalise([
      q({ question: 'nice-to-have A', rank: 1 }),
      q({ question: 'blocker B', rank: 4, blocking: true }),
      q({ question: 'nice-to-have C', rank: 2 }),
      q({ question: 'blocker A', rank: 3, blocking: true }),
    ]);
    expect(out.map((x) => x.question)).toEqual([
      'blocker A', 'blocker B', 'nice-to-have A', 'nice-to-have C',
    ]);
    expect(out.map((x) => x.n)).toEqual([1, 2, 3, 4]);
  });

  it('produces a stable total order when the model repeats a rank', () => {
    // Duplicate ranks also collided as React keys before `n` existed.
    const input = [
      q({ question: 'zebra', rank: 1 }),
      q({ question: 'apple', rank: 1 }),
    ];
    const first = canonicalise(input).map((x) => x.question);
    const second = canonicalise([...input].reverse()).map((x) => x.question);
    expect(first).toEqual(second);
    expect(new Set(canonicalise(input).map((x) => x.n)).size).toBe(2);
  });

  it('does not mutate its input', () => {
    const input = [q({ question: 'b', rank: 2 }), q({ question: 'a', rank: 1 })];
    const before = input.map((x) => x.question);
    canonicalise(input);
    expect(input.map((x) => x.question)).toEqual(before);
  });

  it('handles an empty list', () => {
    expect(canonicalise([])).toEqual([]);
  });
});

describe('the three renderings agree', () => {
  const questions = canonicalise([
    q({ question: 'What is the budget?', rank: 5, blocking: true }),
    q({ question: 'Who signs off?', rank: 2 }),
    q({ question: 'Who is the audience?', rank: 1, blocking: true }),
    q({ question: 'What is the deadline?', rank: 9 }),
  ]);

  it('gives every question one number across list, copy and message', () => {
    const message = buildMessage(questions, 'Q3 launch', 'Sarah');
    const plain = buildPlainText(questions);

    for (const question of questions) {
      const line = `${question.n}. ${question.question}`;
      // THE regression: the same string, numbered identically, in both artefacts.
      expect(plain, 'plain text').toContain(line);
      expect(message, 'ready-to-send message').toContain(line);
    }
  });

  it('numbers the message consecutively, because blocking-first IS the order', () => {
    // A consequence of the canonical order rather than of renumbering: the
    // message groups blocking first, and since that is also the sort, the numbers
    // within each group come out consecutive rather than scattered.
    const message = buildMessage(questions, null, null);
    const numbers = [...message.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3, 4]);
  });
});

describe('buildMessage', () => {
  const blocking = canonicalise([q({ question: 'Who is it for?', rank: 1, blocking: true })]);
  const mixed = canonicalise([
    q({ question: 'Who is it for?', rank: 1, blocking: true }),
    q({ question: 'Any brand rules?', rank: 2 }),
  ]);

  it('addresses the requester by first name', () => {
    expect(buildMessage(mixed, null, 'Sarah')).toMatch(/^Hi Sarah,/);
  });

  it('takes only the first name from free text', () => {
    // The field is free text and someone will paste a full name and a department.
    expect(buildMessage(mixed, null, 'Sarah Chen (Marketing)')).toMatch(/^Hi Sarah,/);
    expect(buildMessage(mixed, null, '  Priya  ')).toMatch(/^Hi Priya,/);
  });

  it('falls back to a bare greeting when nobody is named', () => {
    expect(buildMessage(mixed, null, null)).toMatch(/^Hi,/);
    expect(buildMessage(mixed, null, '   ')).toMatch(/^Hi,/);
  });

  it('names the brief when it has a title', () => {
    expect(buildMessage(mixed, 'Q3 launch', null)).toContain('the Q3 launch brief');
    expect(buildMessage(mixed, null, null)).toContain('the brief');
  });

  it('drops the "and these would sharpen" section when everything blocks', () => {
    const message = buildMessage(blocking, null, null);
    expect(message).toContain('These would each unblock a decision');
    expect(message).not.toContain('sharpen the work');
  });

  it('uses the softer framing when nothing blocks', () => {
    const none = canonicalise([q({ question: 'Any brand rules?', rank: 1 })]);
    const message = buildMessage(none, null, null);
    expect(message).toContain('These would sharpen the work');
    expect(message).not.toContain('unblock a start');
  });

  it('never blames the reader', () => {
    const message = buildMessage(mixed, 'Q3 launch', 'Sarah').toLowerCase();
    // The tone constraint is a product requirement, not a preference: this is
    // forwarded to the person who wrote the brief.
    for (const word of ['missing', 'failed', 'poor', 'weak', 'bad', 'you forgot']) {
      expect(message, `should not contain "${word}"`).not.toContain(word);
    }
  });
});
