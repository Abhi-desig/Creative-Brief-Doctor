/**
 * Lets an async generator emit events that are produced by a CALLBACK fired
 * during a long await.
 *
 * The bug this exists to fix: `runStreaming` wanted to emit a `scoring` status
 * the moment the model produced its first token. It passed an `onFirstToken`
 * callback down through the engine to the adapter, which called it at exactly the
 * right moment — and then the callback did `events.push(...)`, because a callback
 * nested inside `await run(...)` CANNOT `yield` from the enclosing generator.
 * `push` is not `yield`. The array was drained after the await returned, so the
 * browser sat on "Reading the brief" for the entire 22-33 second generation and
 * then received `scoring`, `saving` and `result` back to back in milliseconds.
 * The whole `onFirstToken` chain was wasted.
 *
 * The shape of the fix is a queue the generator drains BETWEEN awaits: rather
 * than awaiting the work directly, the generator races the work against "an item
 * arrived in the queue", so it wakes up on either and can yield in between.
 *
 * Kept separate from DiagnosisService so it can be tested for ordering and timing
 * without a database or a provider — which is the property the e2e suite could not
 * check, since it buffers the whole stream and then asserts with `toContain`.
 */

/**
 * A single-consumer queue that can be waited on.
 *
 * Single-consumer is a real constraint, not an oversight: `wait()` keeps one
 * resolver, so two concurrent waiters would lose one. Only the generator waits,
 * and it waits once at a time.
 */
export class EventQueue<T> {
  private items: T[] = [];
  private notify: (() => void) | null = null;

  push(item: T): void {
    this.items.push(item);
    const notify = this.notify;
    this.notify = null;
    notify?.();
  }

  /** Takes everything currently queued, leaving it empty. */
  drain(): T[] {
    if (this.items.length === 0) return [];
    const out = this.items;
    this.items = [];
    return out;
  }

  get pending(): number {
    return this.items.length;
  }

  /** Resolves on the next `push`. */
  wait(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.notify = resolve;
    });
  }
}

/**
 * Yields queued events as they arrive while `work` is in flight, then returns
 * `work`'s value.
 *
 *   const result = yield* interleave(runPromise, queue);
 *
 * `work`'s rejection is captured immediately rather than left to float, so
 * awaiting the queue can never produce an unhandled rejection warning; it is
 * re-thrown after the final drain so no event produced just before the failure is
 * lost.
 */
export async function* interleave<E, T>(
  work: Promise<T>,
  queue: EventQueue<E>,
): AsyncGenerator<E, T> {
  // A box rather than a bare local: TypeScript will not narrow a variable that is
  // assigned inside a callback, so the outcome is read through a mutable holder
  // and checked explicitly below.
  const box: { outcome: { ok: true; value: T } | { ok: false; error: unknown } | null } = {
    outcome: null,
  };

  const settled = work.then(
    (value) => {
      box.outcome = { ok: true, value };
    },
    (error: unknown) => {
      box.outcome = { ok: false, error };
    },
  );

  while (box.outcome === null) {
    for (const event of queue.drain()) yield event;
    if (box.outcome !== null) break;
    // Wakes on whichever comes first. If the work settles while nothing is
    // queued, the abandoned `wait()` promise is simply never resolved and is
    // collected with the queue.
    await Promise.race([settled, queue.wait()]);
  }

  // Anything pushed between the last drain and the work settling.
  for (const event of queue.drain()) yield event;

  const outcome = box.outcome;
  /* c8 ignore next */
  if (outcome === null) throw new Error('interleave: work settled without an outcome.');
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
