import { describe, expect, it } from 'vitest';
import { EventQueue, interleave } from './interleave.js';

/**
 * The regression these tests exist for is a TIMING bug, so they assert on WHEN
 * events arrive relative to the work finishing — not merely that they all showed
 * up in the right order eventually.
 *
 * That distinction is the entire point. The old implementation produced exactly
 * the same event sequence; every assertion of the form `expect(events).toEqual([
 * 'scoring', 'saving', 'result' ])` passed against it, which is why the e2e suite
 * (which buffers the whole stream and then uses `toContain`) could not catch this.
 * What was wrong was that all three arrived AFTER a 22-33 second await instead of
 * during it.
 */

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('interleave', () => {
  it('yields a queued event BEFORE the work resolves', async () => {
    const queue = new EventQueue<string>();

    let workDone = false;
    const work = (async () => {
      // Stands in for the model call. The event is pushed part-way through.
      await tick(10);
      queue.push('first-token');
      await tick(40);
      workDone = true;
      return 'result';
    })();

    /** What `workDone` was at the moment each event was yielded. */
    const observed: { event: string; workDoneAtYield: boolean }[] = [];
    let returned: string | undefined;

    const generator = interleave(work, queue);
    for (;;) {
      const next = await generator.next();
      if (next.done) {
        returned = next.value;
        break;
      }
      observed.push({ event: next.value, workDoneAtYield: workDone });
    }

    expect(returned).toBe('result');
    expect(observed).toEqual([{ event: 'first-token', workDoneAtYield: false }]);
  });

  it('is measurably early: the event lands nearer the push than the completion', async () => {
    const queue = new EventQueue<string>();
    const PUSH_AT = 20;
    const FINISH_AT = 200;

    const startedAt = Date.now();
    const work = (async () => {
      await tick(PUSH_AT);
      queue.push('first-token');
      await tick(FINISH_AT - PUSH_AT);
      return 'done';
    })();

    const arrivals: number[] = [];
    for await (const _event of interleave(work, queue)) {
      arrivals.push(Date.now() - startedAt);
    }

    expect(arrivals).toHaveLength(1);
    // The old code yielded this at ~FINISH_AT. Asserting it arrives before the
    // midpoint is a wide enough margin to be robust on a loaded CI box and still
    // fails hard against a drain-after-await implementation.
    expect(arrivals[0]).toBeLessThan((PUSH_AT + FINISH_AT) / 2);
  });

  it('yields several events as they arrive, each before the next is pushed', async () => {
    const queue = new EventQueue<number>();
    const pushed: number[] = [];

    const work = (async () => {
      for (const n of [1, 2, 3]) {
        await tick(10);
        pushed.push(n);
        queue.push(n);
      }
      await tick(10);
      return 'end';
    })();

    /** How many items had been pushed in total when each event was yielded. */
    const seen: { event: number; pushedSoFar: number }[] = [];
    for await (const event of interleave(work, queue)) {
      seen.push({ event, pushedSoFar: pushed.length });
    }

    // Each event is consumed while it is still the most recent push — proof the
    // generator is keeping pace rather than draining a backlog at the end.
    expect(seen).toEqual([
      { event: 1, pushedSoFar: 1 },
      { event: 2, pushedSoFar: 2 },
      { event: 3, pushedSoFar: 3 },
    ]);
  });

  it('returns the work value when nothing is ever queued', async () => {
    const queue = new EventQueue<string>();
    const events: string[] = [];

    const generator = interleave(Promise.resolve('only-result'), queue);
    for (;;) {
      const next = await generator.next();
      if (next.done) {
        expect(next.value).toBe('only-result');
        break;
      }
      events.push(next.value);
    }
    expect(events).toEqual([]);
  });

  it('rethrows the work error, after flushing events queued before it failed', async () => {
    const queue = new EventQueue<string>();
    const work = (async () => {
      await tick(5);
      queue.push('first-token');
      await tick(5);
      throw new Error('upstream exploded');
    })();

    const events: string[] = [];
    await expect(async () => {
      for await (const event of interleave(work, queue)) events.push(event);
    }).rejects.toThrow('upstream exploded');

    // The event pushed before the failure is not swallowed by it: a client that
    // saw `scoring` and then an error frame is coherent, one that saw only the
    // error has lost a phase transition.
    expect(events).toEqual(['first-token']);
  });

  it('does not raise an unhandled rejection while awaiting the queue', async () => {
    // The work rejects almost immediately while the generator is parked on
    // `queue.wait()`. If the rejection were not captured up front, Node would
    // report an unhandled rejection here.
    const queue = new EventQueue<string>();
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const work = (async () => {
        await tick(5);
        throw new Error('early failure');
      })();

      await expect(async () => {
        for await (const _ of interleave(work, queue)) {
          // no events
        }
      }).rejects.toThrow('early failure');

      // Give the microtask queue a chance to surface a stray rejection.
      await tick(20);
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('flushes an event pushed in the same tick the work settles', async () => {
    const queue = new EventQueue<string>();
    const work = (async () => {
      await tick(5);
      // Pushed and then settled with no await between: the event is only visible
      // to the final drain, never to a mid-loop one.
      queue.push('late');
      return 'done';
    })();

    const events: string[] = [];
    for await (const event of interleave(work, queue)) events.push(event);
    expect(events).toEqual(['late']);
  });
});

describe('EventQueue', () => {
  it('drains to empty and reports pending count', () => {
    const queue = new EventQueue<number>();
    expect(queue.pending).toBe(0);
    expect(queue.drain()).toEqual([]);

    queue.push(1);
    queue.push(2);
    expect(queue.pending).toBe(2);
    expect(queue.drain()).toEqual([1, 2]);
    expect(queue.pending).toBe(0);
    expect(queue.drain()).toEqual([]);
  });

  it('resolves wait() on the next push', async () => {
    const queue = new EventQueue<string>();
    let resolved = false;
    const waiting = queue.wait().then(() => {
      resolved = true;
    });

    await tick(5);
    expect(resolved).toBe(false);

    queue.push('go');
    await waiting;
    expect(resolved).toBe(true);
  });
});
