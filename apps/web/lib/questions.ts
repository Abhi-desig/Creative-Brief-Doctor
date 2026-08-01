import type { Dimension } from '@cbd/contracts';

/**
 * Ordering, numbering and message-building for follow-up questions.
 *
 * Pure, and in `lib` rather than inside the component, for two reasons. It is the
 * logic most worth testing on this side of the app — the numbering was genuinely
 * broken and the message is the artefact the whole product exists to produce — and
 * keeping it out of a `.tsx` means a test can import it without pulling React and
 * the entire UI component tree into the module graph.
 */

export interface QuestionRow {
  dimension: Dimension;
  question: string;
  blocking: boolean;
  rank: number;
}

/** A question with the ONE number it is known by everywhere on the page. */
export interface NumberedQuestion extends QuestionRow {
  n: number;
}

/**
 * Establishes the canonical order and numbering, once.
 *
 * The same question previously carried three different numbers on one page: the
 * on-screen list printed the model's raw `rank`, the copied text printed its
 * position after sorting, and the ready-to-send message regrouped blocking
 * questions first and numbered from 1 again. So a question could be "3" in the
 * list, "2" in the copy and "5" in the message — and the entire point of these is
 * that two colleagues discuss them over email.
 *
 * `rank` cannot be trusted to be consecutive or unique either: the rubric asks for
 * that in a `.describe()` string, which is a request to a model, not a constraint.
 * Duplicates also collided as React keys.
 *
 * Blocking-first is the canonical order because the message already grouped that
 * way and that grouping is the part a recipient acts on. Within each group the
 * model's own ranking is preserved, since the rubric asks it to rank in the order
 * it would actually send them.
 */
export function canonicalise(questions: QuestionRow[]): NumberedQuestion[] {
  return [...questions]
    .sort((a, b) => {
      if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
      if (a.rank !== b.rank) return a.rank - b.rank;
      // A total order even when the model repeats a rank, so the numbering is
      // stable across re-renders rather than depending on the sort implementation.
      return a.question.localeCompare(b.question);
    })
    .map((q, i) => ({ ...q, n: i + 1 }));
}

/** The plain numbered list, for the copy button. */
export function buildPlainText(questions: NumberedQuestion[]): string {
  return questions.map((q) => `${q.n}. ${q.question}`).join('\n');
}

/**
 * The pre-written message. Opens by thanking and closes by making it easy to
 * answer — this is the artefact that gets forwarded, so its tone is the product's
 * tone.
 */
export function buildMessage(
  questions: NumberedQuestion[],
  briefTitle: string | null,
  requester: string | null,
): string {
  const subject = briefTitle ? `the ${briefTitle} brief` : 'the brief';
  const blocking = questions.filter((q) => q.blocking);
  const rest = questions.filter((q) => !q.blocking);

  /**
   * The whole reason `requester` is captured and carried through the API's report
   * projection: "Hi Sarah," is something you send, "Hi," is something you edit
   * first. Trimmed and first-name-only — the field is free text and someone will
   * paste "Sarah Chen (Marketing)" into it.
   */
  const name = requester?.trim().split(/\s+/)[0];
  const greeting = name ? `Hi ${name},` : 'Hi,';

  const lines: string[] = [
    greeting,
    '',
    `Thanks for ${subject} — there's a lot here to work with. Before we start, a `
      + 'few things would help us get it right first time.',
    '',
  ];

  if (blocking.length > 0) {
    lines.push(
      blocking.length === questions.length
        ? 'These would each unblock a decision:'
        : 'These would unblock a start:',
      '',
      // `q.n`, not a fresh counter. The numbers here match the on-screen list
      // exactly, which is what makes "can you look at 4?" mean one thing.
      ...blocking.map((q) => `${q.n}. ${q.question}`),
      '',
    );
  }

  if (rest.length > 0) {
    lines.push(
      blocking.length > 0
        ? 'And these would sharpen the work, though we can begin without them:'
        : 'These would sharpen the work:',
      '',
      ...rest.map((q) => `${q.n}. ${q.question}`),
      '',
    );
  }

  lines.push(
    'A sentence or two on each is plenty — no need to rewrite anything.',
    '',
    'Thanks!',
  );

  return lines.join('\n');
}
