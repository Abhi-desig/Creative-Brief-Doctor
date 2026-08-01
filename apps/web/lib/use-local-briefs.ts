'use client';

import { useCallback, useSyncExternalStore } from 'react';

/**
 * The list of briefs scored on THIS DEVICE, in localStorage.
 *
 * There are no accounts, and deliberately so — nothing here is account-shaped,
 * not even greyed out. The honest claim localStorage can make is exactly "this
 * browser scored these", which is why every surface built on it says "on this
 * device" rather than "your briefs", and why the empty state says the report link
 * is the record.
 *
 * It is also the enabling primitive for the report page's author-only action row:
 * if this device's index contains a `publicId`, this device created that report,
 * so it can show copy-link and re-score AFTER hydration without the server ever
 * varying its HTML.
 *
 * Built on `useSyncExternalStore`, which is the primitive designed for exactly
 * this shape of problem — an external mutable store that React must subscribe to,
 * with a distinct server snapshot. The earlier version read the store inside a
 * `useEffect` and called `setState` synchronously, which works but forces a
 * second render pass on every mount and is what the React Compiler's
 * `set-state-in-effect` rule objects to. `getServerSnapshot` also removes the
 * hydration-mismatch risk structurally rather than by convention.
 */

const STORAGE_KEY = 'cbd.briefs.v1';
/** Enough to be useful, small enough that the rail never becomes a scroll trap. */
const MAX_ENTRIES = 25;

export interface LocalBrief {
  publicId: string;
  title: string | null;
  /** Null until the diagnosis lands, so a failed run is still listed. */
  score: number | null;
  /** Epoch ms. Stored rather than derived so the list survives a clock change. */
  scoredAt: number;
}

/**
 * `getSnapshot` MUST return a referentially stable value between changes, or
 * React re-renders forever with "The result of getSnapshot should be cached".
 * `read()` parses JSON and builds a new array every call, so the parsed result is
 * memoised against the exact raw string it came from and only recomputed when
 * that string actually differs.
 */
let cachedRaw: string | null = null;
let cachedValue: LocalBrief[] = [];

const EMPTY: LocalBrief[] = [];

function parse(raw: string | null): LocalBrief[] {
  if (!raw) return EMPTY;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return EMPTY;
    // Validated on read, not trusted: this is user-writable storage that may hold
    // an older shape, and a crash here would take out the whole page.
    return parsed.filter(
      (entry): entry is LocalBrief =>
        typeof entry === 'object'
        && entry !== null
        && typeof (entry as LocalBrief).publicId === 'string'
        && typeof (entry as LocalBrief).scoredAt === 'number',
    );
  } catch {
    return EMPTY;
  }
}

function getSnapshot(): LocalBrief[] {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    // Storage disabled entirely (Safari private browsing).
    return EMPTY;
  }
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedValue = parse(raw);
  }
  return cachedValue;
}

/** The server has no localStorage, and must render the empty state. */
function getServerSnapshot(): LocalBrief[] {
  return EMPTY;
}

function subscribe(onChange: () => void): () => void {
  // The native `storage` event only fires in OTHER tabs, so a same-tab custom
  // event is needed as well or the sidebar would not update after a score here.
  window.addEventListener(STORAGE_KEY, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(STORAGE_KEY, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/**
 * Adds or updates an entry, MERGING over any existing one rather than replacing
 * it, and moving it to the front.
 *
 * Exported so it can be tested directly — it was inline in a `useCallback`, which
 * is how the following bug shipped unnoticed.
 *
 * Replacing loses data: re-scoring a brief calls `remember` with only the id and
 * a fresh timestamp, and a straight replace wiped the title captured when the
 * brief was first saved, so a re-scored brief silently became "Untitled brief" in
 * the sidebar. A `null` from a caller therefore means "I don't know this field",
 * NOT "clear it" — nothing in the product needs to blank a title, and `forget`
 * exists for removing an entry outright.
 */
export function upsert(all: LocalBrief[], brief: LocalBrief): LocalBrief[] {
  const previous = all.find((b) => b.publicId === brief.publicId);
  const merged: LocalBrief = {
    ...brief,
    title: brief.title ?? previous?.title ?? null,
    score: brief.score ?? previous?.score ?? null,
  };
  return [merged, ...all.filter((b) => b.publicId !== brief.publicId)].slice(0, MAX_ENTRIES);
}

function readDirect(): LocalBrief[] {
  try {
    return parse(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY;
  }
}

function write(entries: LocalBrief[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    window.dispatchEvent(new Event(STORAGE_KEY));
  } catch {
    // Quota exceeded, or storage disabled. A device list is a convenience;
    // losing it must never break scoring.
  }
}

export function useLocalBriefs() {
  const briefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  /**
   * True once the client store has been consulted. Distinguishes "no briefs"
   * from "not read yet" — without it the empty state flashes on every load for
   * someone who does have briefs.
   */
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const remember = useCallback((brief: LocalBrief) => {
    write(upsert(readDirect(), brief));
  }, []);

  const forget = useCallback((publicId: string) => {
    write(readDirect().filter((b) => b.publicId !== publicId));
  }, []);

  /** Real and immediate. A device list with no clear button is a privacy problem
   *  on a shared laptop. */
  const clear = useCallback(() => write([]), []);

  return { briefs, hydrated, remember, forget, clear };
}

/**
 * Whether this device created a given report.
 *
 * Split from the list hook so the report page can ask the single question it
 * cares about. Subscribes to the same store, so it updates if the list is
 * cleared in another tab while a report is open.
 */
export function useIsLocalBrief(publicId: string): boolean {
  const briefs = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return briefs.some((b) => b.publicId === publicId);
}
