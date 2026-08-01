import { describe, expect, it } from 'vitest';
import { Logger, ConsoleLogger } from '@nestjs/common';
import { PROVIDER_PUBLIC_SELECT, REDACTED, redact, redactString } from './redact.js';

/**
 * Required test #1: a known key fed through the request logger does not appear
 * in the output.
 *
 * The assertion is deliberately the strongest available — the captured output is
 * searched for the literal key, and for every suffix of it long enough to be
 * useful, so a partially-masked leak still fails.
 */

const GEMINI_KEY = 'AIzaSyD-ExampleRealisticGeminiKey_9f2Kd8xQ';
const ANTHROPIC_KEY = 'sk-ant-api03-ExampleRealisticAnthropicKey-9f2Kd8xQaZ';
const ARGON_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$RdescudvJCsgt3ub';

describe('redactString — value-shape masking', () => {
  it('masks a Google API key', () => {
    expect(redactString(GEMINI_KEY)).toBe(REDACTED);
    expect(redactString(`key is ${GEMINI_KEY} ok`)).toBe(`key is ${REDACTED} ok`);
  });

  it('masks an Anthropic key, a JWT, a bearer token and an argon2 hash', () => {
    for (const secret of [
      ANTHROPIC_KEY,
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQdQw4w9WgXcQ',
      'Bearer abcdefghijklmnopqrstuvwxyz012345',
      ARGON_HASH,
    ]) {
      expect(redactString(`prefix ${secret} suffix`)).not.toContain(secret);
    }
  });

  it('masks a Postgres URL that carries a password', () => {
    const url = 'postgresql://admin:sup3rs3cret@db.example.com:5432/cbd';
    expect(redactString(url)).not.toContain('sup3rs3cret');
  });

  it('leaves ordinary prose alone', () => {
    const prose = 'The brief does not state a budget, and the audience is described only by age.';
    expect(redactString(prose)).toBe(prose);
  });
});

describe('redact — key-name masking', () => {
  it('masks by property name regardless of the value', () => {
    const redacted = redact({
      apiKey: 'anything at all',
      api_key: 'x',
      password: 'x',
      token: 'x',
      authorization: 'x',
      secret: 'x',
      sessionSecret: 'x',
      keyCiphertext: 'x',
    }) as Record<string, unknown>;
    for (const value of Object.values(redacted)) expect(value).toBe(REDACTED);
  });

  it('keeps keyLast4 visible — it is how the panel identifies a key', () => {
    const redacted = redact({ keyLast4: '8xQa', label: 'Gemini (free tier)' }) as Record<string, unknown>;
    expect(redacted.keyLast4).toBe('8xQa');
    expect(redacted.label).toBe('Gemini (free tier)');
  });

  it('never serialises raw bytes, which is how ciphertext arrives from Prisma', () => {
    const redacted = redact({ blob: Buffer.from('secret bytes here') }) as Record<string, unknown>;
    expect(String(redacted.blob)).toMatch(/^\[BYTES:\d+\]$/);
  });

  it('catches a key hidden under an innocent property name, via value shape', () => {
    const redacted = redact({ label: `Gemini ${GEMINI_KEY}` }) as Record<string, unknown>;
    expect(redacted.label).not.toContain(GEMINI_KEY);
  });

  it('redacts inside nested structures and arrays', () => {
    const redacted = redact({
      providers: [{ label: 'a', apiKey: GEMINI_KEY }, { label: `b ${ANTHROPIC_KEY}` }],
      meta: { deep: { deeper: { note: GEMINI_KEY } } },
    });
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain(GEMINI_KEY);
    expect(serialised).not.toContain(ANTHROPIC_KEY);
  });

  it('redacts a vendor error message, which often echoes the request', () => {
    const error = new Error(`API key not valid: ${GEMINI_KEY}`);
    const redacted = redact(error) as { message: string };
    expect(redacted.message).not.toContain(GEMINI_KEY);
  });

  it('survives a circular structure without throwing', () => {
    const node: Record<string, unknown> = { apiKey: GEMINI_KEY };
    node.self = node;
    expect(() => redact(node)).not.toThrow();
    expect(JSON.stringify(redact(node))).not.toContain(GEMINI_KEY);
  });

  it('bounds depth rather than recursing forever', () => {
    let deep: Record<string, unknown> = { note: GEMINI_KEY };
    for (let i = 0; i < 60; i++) deep = { nested: deep };
    expect(() => redact(deep)).not.toThrow();
    expect(JSON.stringify(redact(deep))).not.toContain(GEMINI_KEY);
  });
});

describe('a known key fed through the REQUEST LOGGER does not appear in output', () => {
  /**
   * The end-to-end version of the assertion: a realistic request body goes
   * through the same redactor the audit interceptor and logger use, is written
   * with a real Nest logger, and stdout/stderr are searched for the key.
   */
  it('does not leak the key, or any usable suffix of it', () => {
    const captured: string[] = [];
    const write = (chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    };
    const originalOut = process.stdout.write.bind(process.stdout);
    const originalErr = process.stderr.write.bind(process.stderr);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = write;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = write;

    try {
      const logger = new Logger('AdminRequest');
      const requestBody = {
        kind: 'GOOGLE',
        label: 'Gemini (free tier)',
        apiKey: GEMINI_KEY,
        headers: {
          authorization: `Bearer ${GEMINI_KEY}`,
          cookie: 'session=abc123',
          'user-agent': 'curl/8.4.0',
        },
        note: `pasted ${GEMINI_KEY} by mistake`,
      };

      logger.log(JSON.stringify(redact(requestBody)));
      logger.error(JSON.stringify(redact(new Error(`upstream rejected ${GEMINI_KEY}`))));

      const output = captured.join('');
      expect(output.length).toBeGreaterThan(0);
      expect(output).not.toContain(GEMINI_KEY);

      // Any suffix long enough to be recognisable must also be absent, so a
      // half-masked value cannot pass.
      for (let length = 12; length <= GEMINI_KEY.length; length += 4) {
        expect(output, `leaked a ${length}-char suffix`).not.toContain(GEMINI_KEY.slice(-length));
      }
      // And the redaction actually ran.
      expect(output).toContain(REDACTED);
      // Non-secret context is preserved, otherwise the log is useless.
      expect(output).toContain('curl/8.4.0');
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = originalOut;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stderr as any).write = originalErr;
    }
  });

  it('holds for the JSON console logger too', () => {
    const captured: string[] = [];
    const originalOut = process.stdout.write.bind(process.stdout);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = (chunk: unknown): boolean => {
      captured.push(String(chunk));
      return true;
    };
    try {
      const logger = new ConsoleLogger({ json: true });
      logger.log(redact({ apiKey: GEMINI_KEY, hash: ARGON_HASH }), 'AdminRequest');
      const output = captured.join('');
      expect(output).not.toContain(GEMINI_KEY);
      expect(output).not.toContain(ARGON_HASH);
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (process.stdout as any).write = originalOut;
    }
  });
});

describe('PROVIDER_PUBLIC_SELECT — write-only enforced by the query', () => {
  it('selects no credential column, so no endpoint could serve one', () => {
    const selected = Object.keys(PROVIDER_PUBLIC_SELECT);
    for (const forbidden of ['keyCiphertext', 'keyIv', 'keyTag']) {
      expect(selected).not.toContain(forbidden);
    }
  });

  it('does select keyLast4, which is what identifies a key in the UI', () => {
    expect(Object.keys(PROVIDER_PUBLIC_SELECT)).toContain('keyLast4');
  });

  it('sets every selected field to true, so nothing is accidentally a nested include', () => {
    for (const value of Object.values(PROVIDER_PUBLIC_SELECT)) expect(value).toBe(true);
  });
});
