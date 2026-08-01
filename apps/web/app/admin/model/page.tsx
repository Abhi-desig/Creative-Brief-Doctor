'use client';

import { useCallback, useEffect, useState } from 'react';
import { adminFetch, AdminApiError } from '@/lib/admin-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

/**
 * The active model and its parameters.
 *
 * THE RULE THIS PAGE EXISTS TO ENFORCE: a parameter the selected provider does
 * not support is NEVER RENDERED. Not rendered-and-disabled, not rendered with a
 * tooltip — absent.
 *
 * A disabled input still tells an operator the knob exists and invites a support
 * question about why it is greyed out. More importantly, "disabled" is a
 * presentational state that a re-render, a stale prop or a copied component can
 * lose, at which point the form submits a parameter the model rejects. Iterating
 * a capability descriptor instead makes the bad state STRUCTURALLY IMPOSSIBLE:
 * there is no input, so there is no value, so there is nothing to submit.
 *
 * This is also why the controls come from the server. Hard-coding the field list
 * here and filtering it would put the decision in two places, and the client's
 * copy would be the one that drifts.
 */

interface Capabilities {
  supportsTemperature: boolean;
  supportsTopP: boolean;
  supportsThinkingBudget: boolean;
  maxOutputTokens: number;
  contextWindow: number;
  structuredOutput: string;
  promptCaching: string;
  nativeTokenCounting: boolean;
}

interface ModelSettings {
  activeProviderId: string | null;
  activeProviderKind: string | null;
  activeProviderLabel: string | null;
  activeModel: string | null;
  maxTokens: number;
  temperature: number | null;
  topP: number | null;
  thinkingBudget: number | null;
  timeoutMs: number;
  maxRetries: number;
  tokenCeiling: number;
  dailyCallCap: number;
  costCeilingUsd: number;
}

interface ModelPayload {
  settings: ModelSettings;
  providers: { id: string; kind: string; label: string; status: string }[];
  degradedReason: string | null;
  capabilities: Capabilities | null;
  controls: Record<string, boolean> | null;
  models: { id: string; displayName: string }[];
}

/**
 * Every numeric control, keyed by the `controls` flag that governs it.
 *
 * `nullable` marks the three parameters a provider may not support. Clearing one
 * sends an explicit null, which is a distinct operation from leaving it alone —
 * it is how an operator moves to a model that rejects the parameter without
 * leaving a stale value behind in the database.
 */
const CONTROLS = [
  { key: 'maxTokens', label: 'Max output tokens', step: 1, nullable: false,
    hint: 'Clamped to the provider ceiling when it is lower.' },
  { key: 'temperature', label: 'Temperature', step: 0.1, nullable: true,
    hint: 'Leave empty to let the provider default apply.' },
  { key: 'topP', label: 'Top P', step: 0.05, nullable: true, hint: '' },
  { key: 'thinkingBudget', label: 'Thinking budget', step: 1, nullable: true,
    hint: 'Reasoning tokens. Counted against the output budget on some models.' },
  { key: 'timeoutMs', label: 'Timeout (ms)', step: 1000, nullable: false, hint: '' },
  { key: 'maxRetries', label: 'Max retries', step: 1, nullable: false, hint: '' },
  { key: 'tokenCeiling', label: 'Input token ceiling', step: 100, nullable: false,
    hint: 'A brief above this is refused before a call is made.' },
  { key: 'dailyCallCap', label: 'Daily call cap', step: 10, nullable: false,
    hint: 'Guards the shared upstream quota. Counted over diagnoses per UTC day.' },
] as const;

export default function ModelPage() {
  const [payload, setPayload] = useState<ModelPayload | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [status, setStatus] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await adminFetch<ModelPayload>('model');
      setPayload(data);
      setProviderId(data.settings.activeProviderId ?? '');
      setModel(data.settings.activeModel ?? '');
      setDraft(
        Object.fromEntries(
          CONTROLS.map(({ key }) => {
            const value = data.settings[key as keyof ModelSettings];
            return [key, value === null || value === undefined ? '' : String(value)];
          }),
        ),
      );
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Could not load settings.',
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!payload) return;
    setSaving(true);
    setStatus(null);

    const body: Record<string, unknown> = {};
    if (providerId) body.activeProviderId = providerId;
    if (model) body.activeModel = model;

    for (const control of CONTROLS) {
      // Skipped entirely when the provider does not support it. The input does
      // not exist, so neither does the value — this loop cannot invent one.
      if (payload.controls && payload.controls[control.key] !== true) continue;

      const raw = draft[control.key];
      if (raw === undefined) continue;
      if (raw.trim() === '') {
        // Empty means CLEAR for a nullable parameter, and means "unchanged" for
        // one that cannot be null — a required field left blank must not be sent
        // as null and rejected by the schema.
        if (control.nullable) body[control.key] = null;
        continue;
      }
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) continue;
      body[control.key] = parsed;
    }

    try {
      await adminFetch('model', { method: 'PATCH', body });
      setStatus({ kind: 'ok', text: 'Saved. New diagnoses use this immediately.' });
      await load();
    } catch (error) {
      setStatus({
        kind: 'error',
        text: error instanceof AdminApiError ? error.message : 'Could not save.',
      });
    } finally {
      setSaving(false);
    }
  }

  if (!payload) {
    return (
      <div className="flex items-center gap-2 py-12">
        <Spinner className="size-4" />
        <p className="text-muted-foreground text-sm">Loading settings…</p>
      </div>
    );
  }

  const { capabilities, controls, providers, models, degradedReason } = payload;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">Model</h1>
        <p className="text-muted-foreground text-sm">
          Changes apply to the next diagnosis. No restart, no redeploy.
        </p>
      </header>

      {degradedReason ? (
        <Card>
          <CardContent className="flex flex-col gap-1">
            <p className="text-sm font-medium">Not currently scoring</p>
            <p className="text-muted-foreground text-sm">
              {degradedReason === 'NO_ACTIVE_PROVIDER'
                ? 'No provider is selected. Add one on the Providers page, then choose it below.'
                : degradedReason === 'PROVIDER_UNAVAILABLE'
                  ? 'The selected provider has no adapter in this build. Choose a different one.'
                  : degradedReason === 'NO_CREDENTIAL'
                    ? 'The selected provider has no API key stored.'
                    : 'The stored API key could not be decrypted. Re-enter it on the Providers page.'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <form onSubmit={save} className="flex flex-col gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Active provider and model</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="provider">Provider</FieldLabel>
              <select
                id="provider"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                className="border-input bg-background focus-visible:ring-ring rounded-lg border px-2.5 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
              >
                <option value="">Select a provider…</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={p.status === 'DISABLED'}>
                    {p.label} ({p.kind}){p.status === 'DISABLED' ? ' — disabled' : ''}
                  </option>
                ))}
              </select>
              <FieldDescription>
                Switching provider re-validates the model and parameters against it.
              </FieldDescription>
            </Field>

            <Field>
              <FieldLabel htmlFor="model">Model</FieldLabel>
              {models.length > 0 ? (
                <select
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className="border-input bg-background focus-visible:ring-ring rounded-lg border px-2.5 py-1.5 text-sm focus-visible:ring-2 focus-visible:outline-none"
                >
                  <option value="">Select a model…</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              ) : (
                // Falls back to free text when the provider's model list is
                // unreachable, so a broken list endpoint cannot lock an operator
                // out of changing the model.
                <Input id="model" value={model} onChange={(e) => setModel(e.target.value)} />
              )}
              <FieldDescription>
                {models.length > 0
                  ? `${models.length} models offered by this provider.`
                  : 'Model list unavailable — enter the id directly.'}
              </FieldDescription>
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Parameters</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5 sm:grid-cols-2">
            {CONTROLS
              // The whole point. An unsupported parameter is filtered out here and
              // therefore has no input, no value and no way to be submitted.
              .filter((control) => !controls || controls[control.key] === true)
              .map((control) => (
                <Field key={control.key}>
                  <FieldLabel htmlFor={control.key}>{control.label}</FieldLabel>
                  <Input
                    id={control.key}
                    type="number"
                    step={control.step}
                    value={draft[control.key] ?? ''}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, [control.key]: e.target.value }))
                    }
                  />
                  {control.hint ? (
                    <FieldDescription>{control.hint}</FieldDescription>
                  ) : null}
                </Field>
              ))}
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={saving} className="gap-2">
            {saving && <Spinner className="size-4" />}
            {saving ? 'Saving…' : 'Save'}
          </Button>
          {status ? (
            <p
              className={`text-sm ${status.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}
              role={status.kind === 'error' ? 'alert' : 'status'}
            >
              {status.text}
            </p>
          ) : null}
        </div>
      </form>

      {capabilities ? (
        <Card>
          <CardHeader>
            <CardTitle>What this provider supports</CardTitle>
          </CardHeader>
          <CardContent>
            {/* Shown as read-only facts, so an operator can see WHY a control is
                absent rather than wondering whether the page is broken. */}
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {[
                ['Structured output', capabilities.structuredOutput],
                ['Prompt caching', capabilities.promptCaching],
                ['Native token counting', capabilities.nativeTokenCounting ? 'yes' : 'no'],
                ['Max output tokens', capabilities.maxOutputTokens.toLocaleString()],
                ['Context window', capabilities.contextWindow.toLocaleString()],
                ['Temperature', capabilities.supportsTemperature ? 'supported' : 'not supported'],
                ['Top P', capabilities.supportsTopP ? 'supported' : 'not supported'],
                ['Thinking budget',
                  capabilities.supportsThinkingBudget ? 'supported' : 'not supported'],
              ].map(([label, value]) => (
                <div key={label} className="flex justify-between gap-4 border-b py-1.5">
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
