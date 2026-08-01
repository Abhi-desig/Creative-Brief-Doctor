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

export function QuestionsBlock({
  questions,
  briefTitle,
}: {
  questions: QuestionRow[];
  briefTitle: string | null;
}) {
  const ordered = [...questions].sort((a, b) => a.rank - b.rank);
  const blocking = ordered.filter((q) => q.blocking);

  const plainText = ordered
    .map((q, i) => `${i + 1}. ${q.question}`)
    .join('\n');

  const messageText = buildMessage(ordered, briefTitle);

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
            <li key={q.rank} className="flex gap-4">
              <span className="text-viz-muted w-5 shrink-0 pt-0.5 text-sm tabular-nums">
                {q.rank}
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
function buildMessage(questions: QuestionRow[], briefTitle: string | null): string {
  const subject = briefTitle ? `the ${briefTitle} brief` : 'the brief';
  const blocking = questions.filter((q) => q.blocking);
  const rest = questions.filter((q) => !q.blocking);

  const lines: string[] = [
    `Hi,`,
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
      ...blocking.map((q, i) => `${i + 1}. ${q.question}`),
      ``,
    );
  }

  if (rest.length > 0) {
    lines.push(
      blocking.length > 0
        ? `And these would sharpen the work, though we can begin without them:`
        : `These would sharpen the work:`,
      ``,
      ...rest.map((q, i) => `${blocking.length + i + 1}. ${q.question}`),
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
