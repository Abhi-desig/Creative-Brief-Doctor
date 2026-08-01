'use client';

import { useState } from 'react';
import { CheckIcon, CopyIcon } from 'lucide-react';
import type { Dimension } from '@cbd/contracts';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { DIMENSION_LABEL } from './dimension-bars';

/**
 * Follow-up questions with copy-to-clipboard — the highest-value interaction in
 * the product, because the point is to send these on rather than rewrite them.
 *
 * Two framings, because the same content gets used two different ways: a plain
 * list to work from, and a ready-to-send message to paste into email or Slack.
 * Tone is collaborative throughout — never "your brief is bad".
 */

export interface QuestionRow {
  dimension: Dimension;
  question: string;
  blocking: boolean;
  rank: number;
}

/** A question with the ONE number it is known by everywhere on this page. */
interface NumberedQuestion extends QuestionRow {
  n: number;
}

/**
 * Establishes the canonical order and numbering, once.
 *
 * The same question previously carried three different numbers on one page: the
 * on-screen list printed the model's raw `rank`, the copied text printed its
 * position after sorting, and the ready-to-send message regrouped blocking
 * questions first and numbered from 1 again. So a question could be "3" in the
 * list, "2" in the copy, and "5" in the message — and the whole point of these is
 * that two people discuss them over email.
 *
 * `rank` cannot be trusted to be consecutive or unique either: the rubric asks
 * for that in a `.describe()` string, which is a request to a model, not a
 * constraint. Duplicates also collided as React keys.
 *
 * Blocking-first is the canonical order because the message already grouped that
 * way and that grouping is worth keeping — it is the part a recipient acts on.
 * Within each group the model's own ranking is preserved, since the rubric asks
 * it to rank in the order it would actually send them.
 */
function canonicalise(questions: QuestionRow[]): NumberedQuestion[] {
  return [...questions]
    .sort((a, b) => {
      if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
      if (a.rank !== b.rank) return a.rank - b.rank;
      // Total order even when the model repeats a rank, so the numbering is
      // stable across re-renders rather than depending on sort implementation.
      return a.question.localeCompare(b.question);
    })
    .map((q, i) => ({ ...q, n: i + 1 }));
}

export function QuestionsBlock({
  questions,
  briefTitle,
  requester,
}: {
  questions: QuestionRow[];
  briefTitle: string | null;
  requester?: string | null;
}) {
  const ordered = canonicalise(questions);
  const blocking = ordered.filter((q) => q.blocking);

  const plainText = ordered.map((q) => `${q.n}. ${q.question}`).join('\n');

  const messageText = buildMessage(ordered, briefTitle, requester ?? null);

  return (
    <Tabs defaultValue="list" className="gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList>
          <TabsTrigger value="list">Question list</TabsTrigger>
          <TabsTrigger value="message">Ready to send</TabsTrigger>
        </TabsList>
        {blocking.length > 0 && (
          <p className="text-muted-foreground text-sm">
            <span className="text-foreground font-medium tabular-nums">
              {blocking.length}
            </span>{' '}
            of {ordered.length} would block a start
          </p>
        )}
      </div>

      <TabsContent value="list" className="flex flex-col gap-5">
        <ol className="flex flex-col gap-4">
          {ordered.map((q) => (
            // Keyed by `n`, which is unique by construction. `rank` is model
            // output and collided on duplicates.
            <li key={q.n} className="flex gap-4">
              <span className="text-viz-muted w-5 shrink-0 pt-0.5 text-sm tabular-nums">
                {q.n}
              </span>
              <div className="flex flex-col gap-2">
                <p className="text-foreground text-[0.9375rem]/relaxed text-pretty">
                  {q.question}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="font-normal">
                    {DIMENSION_LABEL[q.dimension]}
                  </Badge>
                  {q.blocking && (
                    /* Not a status colour. "Blocking" is a scheduling fact, not
                       a severity, so it must not borrow the danger palette. */
                    <Badge variant="secondary" className="font-normal">
                      Blocks a start
                    </Badge>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ol>
        <CopyButton text={plainText} label="Copy all questions" />
      </TabsContent>

      <TabsContent value="message" className="flex flex-col gap-5">
        <pre className="bg-muted/40 text-foreground/90 overflow-x-auto rounded-lg border p-5 font-sans text-[0.9375rem]/relaxed whitespace-pre-wrap">
          {messageText}
        </pre>
        <CopyButton text={messageText} label="Copy message" />
      </TabsContent>
    </Tabs>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard can be blocked by permissions policy. The text is visible on
      // the page either way, so this degrades to manual selection rather than
      // failing loudly at someone who just wanted to copy.
      setCopied(false);
    }
  }

  return (
    <Button variant="outline" onClick={copy} className="w-fit gap-2">
      {copied ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : (
        <CopyIcon className="size-4" aria-hidden="true" />
      )}
      {copied ? 'Copied' : label}
    </Button>
  );
}

/**
 * The pre-written message. Deliberately opens by thanking and closes by making
 * it easy to answer — this is the artefact that gets forwarded, so its tone is
 * the product's tone.
 */
function buildMessage(
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
    ``,
    `Thanks for ${subject} — there's a lot here to work with. Before we start, a `
      + `few things would help us get it right first time.`,
    ``,
  ];

  if (blocking.length > 0) {
    lines.push(
      blocking.length === questions.length
        ? `These would each unblock a decision:`
        : `These would unblock a start:`,
      ``,
      // `q.n`, not a fresh counter. The numbers here match the on-screen list
      // exactly, which is what makes "can you look at 4?" mean one thing.
      ...blocking.map((q) => `${q.n}. ${q.question}`),
      ``,
    );
  }

  if (rest.length > 0) {
    lines.push(
      blocking.length > 0
        ? `And these would sharpen the work, though we can begin without them:`
        : `These would sharpen the work:`,
      ``,
      ...rest.map((q) => `${q.n}. ${q.question}`),
      ``,
    );
  }

  lines.push(
    `A sentence or two on each is plenty — no need to rewrite anything.`,
    ``,
    `Thanks!`,
  );

  return lines.join('\n');
}
