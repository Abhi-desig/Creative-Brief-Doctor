'use client';

/**
 * Client-side admin API calls.
 *
 * Every mutation goes through here so the CSRF header is attached in exactly one
 * place. The token is read from the `csrf_token` cookie, which is deliberately
 * NOT httpOnly — the double-submit pattern depends on our own code being able to
 * read it and copy it into a header, which is the thing a cross-site request
 * cannot do.
 *
 * No bearer token is involved anywhere on the client. It lives sealed in an
 * httpOnly cookie and is attached by the route handler, so nothing here can leak
 * an admin credential.
 */

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AdminApiError';
  }
}

function csrfToken(): string {
  for (const part of document.cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'csrf_token') return decodeURIComponent(rest.join('='));
  }
  return '';
}

export async function adminFetch<T>(
  path: string,
  init: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = init.method ?? 'GET';
  const mutating = method !== 'GET';

  const response = await fetch(`/api/admin/${path}`, {
    method,
    headers: {
      ...(mutating ? { 'content-type': 'application/json', 'x-csrf-token': csrfToken() } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.signal ? { signal: init.signal } : {}),
    cache: 'no-store',
  });

  if (response.status === 401) {
    // The session expired or was revoked. A full reload lets the middleware do
    // the redirect, so there is one place that decides where an unauthenticated
    // admin goes.
    window.location.href = '/admin/login';
    throw new AdminApiError('Session expired.', 401, 'NO_SESSION');
  }

  const text = await response.text();
  const body = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const detail = body as { message?: string | string[]; code?: string } | null;
    // Zod validation errors arrive as an array of issues; joining them beats
    // rendering "[object Object]" at an operator trying to fix a setting.
    const message = Array.isArray(detail?.message)
      ? detail.message.join('; ')
      : (detail?.message ?? `Request failed (${response.status}).`);
    throw new AdminApiError(message, response.status, detail?.code);
  }

  return body as T;
}

export async function signOut(): Promise<void> {
  await fetch('/api/admin/session', { method: 'DELETE' });
  window.location.href = '/admin/login';
}
