'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { standardSchemaResolver } from '@hookform/resolvers/standard-schema';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';
import { StreamAbortedError, streamDiagnosis } from '@/lib/sse-client';
import { ScoringProgress, type Phase } from './scoring-progress';

/**
 * The paste box.
 *
 * Validation runs off a zod schema through the Standard Schema resolver, and
 * `FieldError` consumes the resulting issues directly — no adapter layer between
 * the schema and the field. The same 20,000-character cap is enforced again at
 * the API DTO, because a client-side cap is a courtesy, not a control.
 */

const MAX_CHARS = 20_000;

const PasteSchema = z
  .object({
    title: z.string().max(200).optional(),
    text: z
      .string()
      .min(40, 'That is too short to diagnose — paste the whole brief.')
      .max(MAX_CHARS, `Briefs are capped at ${MAX_CHARS.toLocaleString()} characters.`),
  })
  .strict();

type PasteValues = z.infer<typeof PasteSchema>;

export function PasteForm() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase | null>(null);

  /**
   * One controller per submission, aborted on unmount.
   *
   * Without this, a client-side navigation away from this page left the reader
   * open, which held the proxy's request open, which meant the API never saw a
   * disconnect and never aborted the model call. The abort chain exists all the
   * way down to the adapter's fetch; this ref is its first link.
   */
  const abortRef = useRef<AbortController | null>(null);
  /** Guards `setPhase` — a resolved await after unmount would set state on a
   *  component React has already torn down. */
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
    };
  }, []);

  const form = useForm<PasteValues>({
    resolver: standardSchemaResolver(PasteSchema),
    defaultValues: { title: '', text: '' },
    mode: 'onBlur',
  });

  const text = form.watch('text') ?? '';
  const busy = phase !== null;

  async function onSubmit(values: PasteValues) {
    // Supersede any in-flight run rather than racing it.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPhase('reading');
    try {
      const created = await fetch('/api/briefs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: values.text,
          ...(values.title ? { title: values.title } : {}),
        }),
        signal: controller.signal,
      });

      if (!created.ok) {
        const body = (await created.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? 'Could not save the brief.');
      }

      const { publicId } = (await created.json()) as { publicId: string };
      await streamDiagnosis(
        publicId,
        (next) => {
          if (mountedRef.current) setPhase(next);
        },
        controller.signal,
      );
      // Full navigation so the report is server-rendered exactly as a
      // stakeholder opening the link would see it.
      router.push(`/d/${publicId}`);
    } catch (error) {
      // A cancellation is the user's own action — navigating away, or resubmitting.
      // Reporting it as a failure would blame them for something they asked for.
      if (error instanceof StreamAbortedError || !mountedRef.current) return;
      if ((error as { name?: string })?.name === 'AbortError') return;

      setPhase(null);
      toast.add({
        title: 'Scoring did not finish',
        description: error instanceof Error ? error.message : 'Something went wrong.',
      });
    }
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
      <Field>
        <FieldLabel htmlFor="title">Brief name</FieldLabel>
        <Input
          id="title"
          placeholder="Q3 product launch"
          disabled={busy}
          {...form.register('title')}
        />
        <FieldDescription>
          Optional. Appears at the top of the shared report.
        </FieldDescription>
        <FieldError errors={[form.formState.errors.title]} />
      </Field>

      <Field data-invalid={form.formState.errors.text ? true : undefined}>
        <FieldLabel htmlFor="text">The brief</FieldLabel>
        <Textarea
          id="text"
          rows={14}
          placeholder="Paste the whole brief, exactly as you received it."
          disabled={busy}
          className="resize-y"
          {...form.register('text')}
        />
        <div className="flex items-baseline justify-between gap-4">
          <FieldDescription>
            Nothing is scored until you press the button.
          </FieldDescription>
          <span
            className={`shrink-0 text-xs tabular-nums ${
              text.length > MAX_CHARS ? 'text-destructive' : 'text-viz-muted'
            }`}
          >
            {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
          </span>
        </div>
        <FieldError errors={[form.formState.errors.text]} />
      </Field>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={busy} className="gap-2">
          {busy && <Spinner className="size-4" />}
          {busy ? 'Scoring…' : 'Diagnose this brief'}
        </Button>
        {phase && <ScoringProgress phase={phase} />}
      </div>
    </form>
  );
}
