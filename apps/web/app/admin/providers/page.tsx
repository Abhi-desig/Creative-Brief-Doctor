'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, AdminApiError } from '@/lib/admin-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/**
 * Provider credentials.
 *
 * Keys are WRITE-ONLY over HTTP: they can be set and rotated, and no endpoint
 * returns one — the API's reads select columns that do not include the
 * credential, so there is no code path that could serve a key rather than a
 * convention that one should not. This page therefore has no reveal control,
 * because there is nothing to build one out of. The last four characters are the
 * only feedback that a key is present, and they come from a stored digest.
 */

interface Provider {
  id: string;
  kind: 'GOOGLE' | 'ANTHROPIC';
  label: string;
  baseUrl: string | null;
  status: 'UNTESTED' | 'OK' | 'FAILING' | 'DISABLED';
  keyLast4: string | null;
  keyVersion: number;
  lastTestedAt: string | null;
  createdAt: string;
}

const STATUS_COPY: Record<Provider['status'], string> = {
  UNTESTED: 'Not tested',
  OK: 'Working',
  FAILING: 'Failing',
  DISABLED: 'Disabled',
};

export default function ProvidersPage() {
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [status, setStatus] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setProviders(await adminFetch<Provider[]>('providers'));
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not load providers.',
      });
    }
  }, []);

  // `load` awaits before it touches state, so the update lands in a microtask
  // rather than synchronously — the cascading render this rule guards against
  // cannot happen here. The analysis is conservative about any function that
  // transitively setStates.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function run(id: string, work: () => Promise<unknown>, okText: string) {
    setBusy(id);
    setStatus(null);
    try {
      await work();
      setStatus({ kind: 'ok', text: okText });
      await load();
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof AdminApiError ? error.message : 'Something went wrong.',
      });
    } finally {
      setBusy(null);
    }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const baseUrl = String(data.get('baseUrl') ?? '').trim();

    await run(
      'new',
      () =>
        adminFetch('providers', {
          method: 'POST',
          body: {
            kind: String(data.get('kind')),
            label: String(data.get('label')),
            apiKey: String(data.get('apiKey')),
            ...(baseUrl ? { baseUrl } : {}),
          },
        }),
      'Provider added. Select it on the Model page to make it active.',
    );
    // Clears the key field from the DOM as soon as it has been sent.
    form.reset();
  }

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Providers</h1>
        <p className="text-muted-foreground text-sm">
          API keys are encrypted at rest and never returned by any endpoint.
        </p>
      </header>

      {status ? (
        <p
          className={`text-sm ${status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
          role={status.kind === 'error' ? 'alert' : 'status'}
        >
          {status.text}
        </p>
      ) : null}

      {providers === null ? (
        <div className="flex items-center gap-2 py-8">
          <Spinner className="size-4" />
          <p className="text-muted-foreground text-sm">Loading…</p>
        </div>
      ) : providers.length === 0 ? (
        <Card>
          <CardContent>
            <p className="text-muted-foreground text-sm">
              No providers yet. Add one below — the app boots healthy-but-degraded
              until one is configured, which is why nothing is currently scoring.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {providers.map((provider) => (
            <Card key={provider.id}>
              <CardContent className="flex flex-col gap-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div className="flex flex-col gap-0.5">
                    <p className="font-medium">{provider.label}</p>
                    <p className="text-muted-foreground text-xs">
                      {provider.kind}
                      {provider.keyLast4 ? ` · key ····${provider.keyLast4}` : ' · no key stored'}
                      {provider.keyVersion > 1 ? ` · v${provider.keyVersion}` : ''}
                    </p>
                  </div>
                  {/* Word, not a coloured pill. "Failing" needs to be legible, not
                      alarming, and the operator is already looking at it. */}
                  <span className="text-muted-foreground text-xs">
                    {STATUS_COPY[provider.status]}
                    {provider.lastTestedAt
                      ? ` · tested ${new Date(provider.lastTestedAt).toLocaleString()}`
                      : ''}
                  </span>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === provider.id}
                    onClick={() =>
                      void run(
                        provider.id,
                        () => adminFetch(`providers/${provider.id}/test-connection`, {
                          method: 'POST',
                          body: {},
                        }),
                        'Connection tested.',
                      )
                    }
                  >
                    Test connection
                  </Button>

                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy === provider.id}
                    onClick={() =>
                      void run(
                        provider.id,
                        () =>
                          adminFetch(`providers/${provider.id}`, {
                            method: 'PATCH',
                            body: {
                              status: provider.status === 'DISABLED' ? 'UNTESTED' : 'DISABLED',
                            },
                          }),
                        provider.status === 'DISABLED' ? 'Provider enabled.' : 'Provider disabled.',
                      )
                    }
                  >
                    {provider.status === 'DISABLED' ? 'Enable' : 'Disable'}
                  </Button>
                </div>

                <details className="text-sm">
                  <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
                    Rotate key
                  </summary>
                  <form
                    className="mt-3 flex flex-wrap items-end gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      const key = String(new FormData(form).get('apiKey') ?? '');
                      void run(
                        provider.id,
                        () =>
                          adminFetch(`providers/${provider.id}`, {
                            method: 'PATCH',
                            body: { apiKey: key },
                          }),
                        'Key rotated.',
                      ).then(() => form.reset());
                    }}
                  >
                    <Input
                      name="apiKey"
                      type="password"
                      required
                      minLength={8}
                      placeholder="New API key"
                      autoComplete="off"
                      className="w-64"
                    />
                    <Button type="submit" size="sm" disabled={busy === provider.id}>
                      Rotate
                    </Button>
                  </form>
                </details>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Add a provider</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-col gap-5">
            <div className="grid gap-5 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="kind">Kind</FieldLabel>
                <select
                  id="kind"
                  name="kind"
                  required
                  className="border-input bg-background focus-visible:ring-ring rounded-lg border px-2.5 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                  <option value="GOOGLE">Google (Gemini)</option>
                  <option value="ANTHROPIC">Anthropic</option>
                </select>
                <FieldDescription>
                  Anthropic has no adapter in this build yet; selecting it as active
                  will be refused with a reason.
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="label">Label</FieldLabel>
                <Input id="label" name="label" required maxLength={80} placeholder="Gemini (prod)" />
                <FieldDescription>Yours to choose. Shown on the Model page.</FieldDescription>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="apiKey">API key</FieldLabel>
              <Input
                id="apiKey"
                name="apiKey"
                type="password"
                required
                minLength={8}
                autoComplete="off"
              />
              <FieldDescription>
                Encrypted with the master key and bound to this provider&rsquo;s id, so
                a copied row is useless without both. Never returned by any endpoint.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="baseUrl">Base URL</FieldLabel>
              <Input id="baseUrl" name="baseUrl" type="url" placeholder="Optional" />
              <FieldDescription>Only for a proxy or a compatible gateway.</FieldDescription>
            </Field>

            <Button type="submit" disabled={busy === 'new'} className="w-fit gap-2">
              {busy === 'new' && <Spinner className="size-4" />}
              Add provider
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
