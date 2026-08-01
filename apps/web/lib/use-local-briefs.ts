'use client';

import { useCallback, useEffect, useState } from 'react';

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
 * varying its HTML. A stakeholder opening a forwarded link has no entry and sees a
 * clean document.
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

function read(): LocalBrief[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
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
    return [];
  }
}

function write(entries: LocalBrief[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    // Same-tab listeners: the native `storage` event only fires in OTHER tabs, so
    // without this the sidebar would not update after a score in this one.
    window.dispatchEvent(new Event(STORAGE_KEY));
  } catch {
    // Quota exceeded, or storage disabled entirely (Safari private browsing).
    // A device list is a convenience; losing it must never break scoring.
  }
}

export function useLocalBriefs() {
  /**
   * Starts empty on every render, including the client's first.
   *
   * Reading localStorage during the initial render would make the client's first
   * paint disagree with the server's HTML and produce a hydration mismatch, so
   * the list is populated in an effect. Consumers get `hydrated` to distinguish
   * "no briefs" from "not read yet" — without it, the empty state flashes on
   * every load for someone who does have briefs.
   */
  const [briefs, setBriefs] = useState<LocalBrief[]>([]);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const sync = () => setBriefs(read());
    sync();
    setHydrated(true);

    window.addEventListener(STORAGE_KEY, sync);
    // Cross-tab: clearing the list in one tab should empty it in the others.
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(STORAGE_KEY, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const remember = useCallback((brief: LocalBrief) => {
    const existing = read().filter((b) => b.publicId !== brief.publicId);
    write([brief, ...existing].slice(0, MAX_ENTRIES));
  }, []);

  const forget = useCallback((publicId: string) => {
    write(read().filter((b) => b.publicId !== publicId));
  }, []);

  /** Real and immediate. A device list with no clear button is a privacy problem
   *  on a shared laptop. */
  const clear = useCallback(() => write([]), []);

  return { briefs, hydrated, remember, forget, clear };
}

/**
 * Whether this device created a given report.
 *
 * Split out from the list hook so the report page can ask the single question it
 * cares about without subscribing to the whole collection.
 */
export function useIsLocalBrief(publicId: string): boolean {
  const [isLocal, setIsLocal] = useState(false);

  useEffect(() => {
    const sync = () => setIsLocal(read().some((b) => b.publicId === publicId));
    sync();
    window.addEventListener(STORAGE_KEY, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(STORAGE_KEY, sync);
      window.removeEventListener('storage', sync);
    };
  }, [publicId]);

  return isLocal;
}
