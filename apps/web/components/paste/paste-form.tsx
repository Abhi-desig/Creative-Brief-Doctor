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
import { useLocalBriefs } from '@/lib/use-local-briefs';
import { useCapacity } from '@/lib/use-capacity';
import { SAMPLE_BRIEFS } from '@/lib/sample-briefs';
import { Preflight } from './preflight';
import { ScoringView } from './scoring-view';
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
    /**
     * Who the brief came from. One field, not a set of them: three inputs read as
     * an intake form and make the tool feel like paperwork, where one reads as a
     * search box. It earns its place by turning the ready-to-send message's
     * generic `Hi,` into `Hi Sarah,` — the difference between an artefact you
     * send and one you edit first.
     */
    requester: z.string().max(120).optional(),
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
    defaultValues: { title: '', requester: '', text: '' },
    mode: 'onBlur',
  });

  const text = form.watch('text') ?? '';
  const busy = phase !== null;

  const { remember } = useLocalBriefs();
  const capacity = useCapacity();
  // Only a *known* closed day disables the button. An unknown capacity leaves it
  // enabled: the API is the authority and will return a clear 503, whereas a
  // disabled button with no explanation is a dead end.
  const closed = capacity?.state === 'closed';

  function applySample(id: string) {
    const sample = SAMPLE_BRIEFS.find((s) => s.id === id);
    if (!sample) return;
    // `shouldDirty` so validation and the counter update as if typed.
    form.setValue('title', sample.title, { shouldDirty: true });
    form.setValue('requester', sample.requester, { shouldDirty: true });
    form.setValue('text', sample.text, { shouldDirty: true, shouldValidate: true });
  }

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
          ...(values.requester ? { requester: values.requester } : {}),
        }),
        signal: controller.signal,
      });

      if (!created.ok) {
        const body = (await created.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? 'Could not save the brief.');
      }

      const { publicId } = (await created.json()) as { publicId: string };

      /**
       * Recorded BEFORE scoring, with a null score.
       *
       * The brief row exists from this point, so the link already resolves. If
       * the stream then drops, the device list is the only way back to it — five
       * briefs in the dev database reached exactly that state with no retry path.
       * Remembering only on success would have lost every one of them.
       */
      remember({
        publicId,
        title: values.title?.trim() ? values.title.trim() : null,
        score: null,
        scoredAt: Date.now(),
      });

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

  /**
   * The form is REPLACED while scoring, not disabled beneath a spinner.
   *
   * Leaving a greyed-out form on screen for twenty-plus seconds gives the reader
   * nothing to look at but the thing they can no longer use. Swapping in the
   * report's own shape means the wait is spent seeing what is coming.
   *
   * The values are still in the form's state — this is a render swap, not a
   * reset — so an error puts the user back in front of their own text.
   */
  if (phase !== null) {
    return (
      <ScoringView
        phase={phase}
        title={form.getValues('title')?.trim() || 'Untitled brief'}
      />
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-6">
      <SamplePicker onPick={applySample} disabled={busy} />

      <div className="grid gap-6 sm:grid-cols-2">
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

        <Field>
          <FieldLabel htmlFor="requester">Who sent it</FieldLabel>
          <Input
            id="requester"
            placeholder="Sarah"
            disabled={busy}
            {...form.register('requester')}
          />
          <FieldDescription>
            Optional. Used to address the ready-to-send questions.
          </FieldDescription>
          <FieldError errors={[form.formState.errors.requester]} />
        </Field>
      </div>

      <Field data-invalid={form.formState.errors.text ? true : undefined}>
        <FieldLabel htmlFor="text">The brief</FieldLabel>
        <Textarea
          id="text"
          rows={14}
          placeholder="Paste the whole brief, exactly as you received it."
          disabled={busy}
          className="resize-y"
          {...form.register('text')}
          // Cmd/Ctrl+Enter submits. A 20,000-character textarea puts the button a
          // long scroll below the cursor, and this is the gesture people already
          // expect from every other box that takes a long block of text.
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void form.handleSubmit(onSubmit)();
            }
          }}
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

      <Preflight text={text} />

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={busy || closed} className="gap-2">
          {busy && <Spinner className="size-4" />}
          {busy ? 'Scoring…' : 'Diagnose this brief'}
        </Button>

        {phase ? (
          <ScoringProgress phase={phase} />
        ) : closed ? (
          <p className="text-muted-foreground text-sm">
            The daily limit is reached. The model quota is shared across everyone
            using this tool — it resets overnight.
          </p>
        ) : (
          <p className="text-viz-muted hidden text-xs sm:block">
            {/* Shown only where the shortcut exists to be used. */}
            or press{' '}
            <kbd className="bg-muted rounded border px-1 py-0.5 font-sans text-[0.6875rem]">
              ⌘
            </kbd>
            {' + '}
            <kbd className="bg-muted rounded border px-1 py-0.5 font-sans text-[0.6875rem]">
              ↵
            </kbd>
          </p>
        )}
      </div>
    </form>
  );
}

/**
 * "Try a sample brief."
 *
 * Solves the empty textarea in one click, which is the single biggest obstacle to
 * a first-time visitor understanding what this does. Grouped by SHAPE — a two-line
 * chat request, a real brief with gaps, a fully specified one — because that is
 * the actual choice being made, and because it sets an expectation before the
 * score arrives.
 *
 * A native <select>: it needs no JavaScript to be operable, it is one tap on
 * mobile, and it carries its own label and keyboard behaviour.
 */
function SamplePicker({
  onPick,
  disabled,
}: {
  onPick: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor="sample" className="text-muted-foreground text-sm">
        No brief to hand?
      </label>
      <select
        id="sample"
        disabled={disabled}
        defaultValue=""
        onChange={(event) => {
          onPick(event.target.value);
          // Reset so picking the same sample twice still fires — after editing
          // the box, "give me that one again" is a real thing to want.
          event.currentTarget.value = '';
        }}
        className="border-input bg-background focus-visible:ring-ring rounded-lg border px-2.5 py-1.5 text-sm
                   focus-visible:ring-2 focus-visible:outline-none disabled:opacity-50"
      >
        <option value="" disabled>
          Try a sample…
        </option>
        {SAMPLE_BRIEFS.map((sample) => (
          <option key={sample.id} value={sample.id}>
            {sample.label}
          </option>
        ))}
      </select>
    </div>
  );
}
