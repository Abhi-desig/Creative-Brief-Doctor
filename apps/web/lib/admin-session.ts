import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

/**
 * The admin session, held in an encrypted httpOnly cookie.
 *
 * The API authenticates with a bearer token. That token must never reach the
 * browser's JavaScript — an XSS anywhere on the admin surface would otherwise
 * hand an attacker a working admin credential. So the bearer is sealed into an
 * httpOnly cookie here, and every `/api/admin/*` route handler unseals it and
 * attaches it as an `Authorization` header server-side. The browser holds a
 * cookie it cannot read and never sees a token at all.
 *
 * Encrypted rather than merely signed: a signed cookie is still readable, and
 * this one carries the bearer itself. AES-256-GCM, so tampering fails to decrypt
 * rather than being detected afterwards.
 *
 * The CSRF cookie is deliberately the opposite — readable by JavaScript, because
 * the double-submit pattern requires the client to copy it into a header, which
 * is precisely the thing an attacker's cross-site form post cannot do.
 */

// No `.js` extension and via the alias: this package resolves like the rest of
// the web app, not like the NodeNext-style API package next door.
import { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE } from '@/lib/admin-cookies';

const SESSION_COOKIE = ADMIN_SESSION_COOKIE;
const CSRF_COOKIE = ADMIN_CSRF_COOKIE;
/** Matches the API's own session lifetime; the API remains the authority. */
const MAX_AGE_SECONDS = 8 * 60 * 60;

function key(): Buffer {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      'SESSION_SECRET is not set. The admin session cookie cannot be encrypted '
      + 'without it. Generate one with `openssl rand -base64 32`.',
    );
  }
  const raw = Buffer.from(secret, 'base64');
  if (raw.length < 32) {
    throw new Error(
      `SESSION_SECRET decodes to ${raw.length} bytes; 32 are required for AES-256.`,
    );
  }
  return raw.subarray(0, 32);
}

/** `iv.tag.ciphertext`, base64url so it is cookie-safe without escaping. */
function seal(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString('base64url')).join('.');
}

function open(sealed: string): string | null {
  try {
    const [ivPart, tagPart, dataPart] = sealed.split('.');
    if (!ivPart || !tagPart || !dataPart) return null;
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key(),
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // A rotated SESSION_SECRET, a truncated cookie, or tampering. All are
    // "not signed in" rather than an error to show someone.
    return null;
  }
}

export async function createSession(bearer: string): Promise<void> {
  const jar = await cookies();
  const csrf = randomBytes(32).toString('base64url');

  jar.set(SESSION_COOKIE, seal(bearer), {
    httpOnly: true,
    // `lax`, not `strict`: the admin panel is reached by following a link, and
    // `strict` would present a signed-in admin with a login page on arrival.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });

  jar.set(CSRF_COOKIE, csrf, {
    // Readable on purpose — the double-submit token has to be copied into a
    // header by our own client code. An attacker's cross-site request can cause
    // the cookie to be SENT but cannot read it to set the header.
    httpOnly: false,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: MAX_AGE_SECONDS,
  });
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  jar.delete(CSRF_COOKIE);
}

/** The bearer for server-side use only. Never returned to a client component. */
export async function readBearer(): Promise<string | null> {
  const sealed = (await cookies()).get(SESSION_COOKIE)?.value;
  return sealed ? open(sealed) : null;
}

export async function readCsrf(): Promise<string | null> {
  return (await cookies()).get(CSRF_COOKIE)?.value ?? null;
}

/**
 * Confirms the header token matches the cookie.
 *
 * The API enforces this too, and this is not redundant: the proxy route handlers
 * are themselves same-origin endpoints that attach admin credentials, so an
 * attacker who could drive them cross-site would not need to touch the API
 * directly. Checked here in constant time for the same reason as there.
 */
export async function csrfMatches(headerToken: string | null): Promise<boolean> {
  const cookieToken = await readCsrf();
  if (!headerToken || !cookieToken) return false;
  const a = Buffer.from(headerToken);
  const b = Buffer.from(cookieToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Re-exported for convenience on the Node side. Edge-runtime callers must import
// these from `admin-cookies` directly — see the note in that file.
export { ADMIN_CSRF_COOKIE, ADMIN_SESSION_COOKIE };
