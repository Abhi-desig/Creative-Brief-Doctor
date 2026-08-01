import { describe, expect, it } from 'vitest';
import { upsert, type LocalBrief } from './use-local-briefs';

/**
 * The device list's merge behaviour.
 *
 * `upsert` was inline in a `useCallback` and the whole web app had no test runner,
 * which is exactly how the bug below shipped: re-scoring a brief called it with
 * only an id and a timestamp, the straight replace dropped the title captured on
 * the first save, and the sidebar silently relabelled the brief "Untitled brief".
 */

const brief = (over: Partial<LocalBrief> & { publicId: string }): LocalBrief => ({
  title: null,
  score: null,
  scoredAt: 1_000,
  ...over,
});

describe('upsert', () => {
  it('KEEPS an existing title when the caller does not supply one', () => {
    // The regression. Re-scoring supplies only the id and a fresh timestamp.
    const existing = [brief({ publicId: 'abc', title: 'Q3 launch', score: 62 })];
    const after = upsert(existing, brief({ publicId: 'abc', scoredAt: 2_000 }));

    expect(after).toHaveLength(1);
    expect(after[0]!.title).toBe('Q3 launch');
    expect(after[0]!.score).toBe(62);
    expect(after[0]!.scoredAt).toBe(2_000);
  });

  it('overwrites a field when the caller does supply one', () => {
    const existing = [brief({ publicId: 'abc', title: 'Old', score: 10 })];
    const after = upsert(existing, brief({ publicId: 'abc', title: 'New', score: 80 }));
    expect(after[0]!.title).toBe('New');
    expect(after[0]!.score).toBe(80);
  });

  it('adds a brief that is not already listed', () => {
    const after = upsert([brief({ publicId: 'a' })], brief({ publicId: 'b', title: 'B' }));
    expect(after.map((b) => b.publicId)).toEqual(['b', 'a']);
  });

  it('moves an updated brief to the front without duplicating it', () => {
    const existing = [
      brief({ publicId: 'a' }),
      brief({ publicId: 'b' }),
      brief({ publicId: 'c' }),
    ];
    const after = upsert(existing, brief({ publicId: 'c', title: 'C' }));
    expect(after.map((b) => b.publicId)).toEqual(['c', 'a', 'b']);
    expect(after.filter((b) => b.publicId === 'c')).toHaveLength(1);
  });

  it('caps the list so the sidebar never becomes a scroll trap', () => {
    const many = Array.from({ length: 25 }, (_, i) => brief({ publicId: `id-${i}` }));
    const after = upsert(many, brief({ publicId: 'newest' }));
    expect(after).toHaveLength(25);
    expect(after[0]!.publicId).toBe('newest');
    // The oldest fell off the end, not the newly added one.
    expect(after.map((b) => b.publicId)).not.toContain('id-24');
  });

  it('does not mutate the array it is given', () => {
    const existing = [brief({ publicId: 'a', title: 'A' })];
    const snapshot = JSON.stringify(existing);
    upsert(existing, brief({ publicId: 'a', scoredAt: 9_999 }));
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it('records a brief with no score yet, so a failed run is still recoverable', () => {
    // Written BEFORE scoring starts: if the stream drops, the device list is the
    // only route back to the report.
    const after = upsert([], brief({ publicId: 'pending', title: 'Draft', score: null }));
    expect(after[0]!.score).toBeNull();
    expect(after[0]!.title).toBe('Draft');
  });
});
