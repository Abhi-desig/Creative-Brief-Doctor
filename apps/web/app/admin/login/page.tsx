'use client';

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/**
 * Sign in.
 *
 * There is no signup route, no password reset, and no "forgot password" — the
 * single admin credential comes from the environment, so there is no
 * registration surface to attack. The form is correspondingly plain.
 *
 * The error message never distinguishes "no such user" from "wrong password":
 * that distinction is a user-enumeration oracle, and with exactly one account it
 * would confirm the admin's email address to anyone who guessed it.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { message?: string };
        setError(
          response.status === 429
            // The brute-force tier is 5 per 15 minutes. Saying so beats letting
            // an admin retype a correct password four more times.
            ? 'Too many attempts. Wait a few minutes and try again.'
            : (body.message ?? 'Sign in failed.'),
        );
        setBusy(false);
        return;
      }

      /**
       * `next` is a PATH taken from the query string. Anything that is not a
       * same-origin absolute path is discarded — accepting a full URL here would
       * make this an open redirect, and a login page is exactly where one gets
       * used. A leading `//` is rejected too: browsers read it as protocol-
       * relative, so `//evil.example` is an absolute URL wearing a path's clothes.
       */
      const next = params.get('next');
      const safe = next && next.startsWith('/') && !next.startsWith('//') ? next : '/admin';

      // Full navigation, so the middleware re-evaluates with the new cookie.
      window.location.href = safe;
    } catch {
      setError('Could not reach the server.');
      setBusy(false);
    }
    void router;
  }

  return (
    <div className="mx-auto flex min-h-[70dvh] w-full max-w-sm flex-col justify-center gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="text-muted-foreground text-sm">
          Sign in to manage providers, the active model, and the rubric.
        </p>
      </header>

      <form onSubmit={onSubmit} className="flex flex-col gap-5">
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            disabled={busy}
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            disabled={busy}
          />
        </Field>

        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={busy} className="gap-2">
          {busy && <Spinner className="size-4" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}

export default function LoginPage() {
  // `useSearchParams` requires a Suspense boundary to avoid opting the whole
  // route into client-side rendering at build time.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
