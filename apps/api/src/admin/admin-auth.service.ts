import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import type { Env } from '../config/env.schema.js';

/**
 * Single-administrator authentication. Narrow on purpose.
 *
 * Not a user system: there is no signup route, no password reset, no
 * registration endpoint to attack, and no users table. Credentials come from
 * ADMIN_EMAIL and ADMIN_PASSWORD_HASH (argon2id), so plaintext never exists in
 * the repo, the database, or the container.
 *
 * The bearer this issues is short-lived and HMAC-signed with SESSION_SECRET. It
 * is held by the Next.js server inside an encrypted httpOnly cookie — the
 * browser never sees an API credential and never talks to the API directly.
 */

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** One generic failure message. Never says which half was wrong. */
const GENERIC_FAILURE = 'Invalid credentials.';

export interface AdminSession {
  email: string;
  issuedAt: number;
  lastSeenAt: number;
  expiresAt: number;
  jti: string;
}

@Injectable()
export class AdminAuthService {
  private readonly logger = new Logger(AdminAuthService.name);
  private readonly adminEmail: string;
  private readonly passwordHash: string | undefined;
  private readonly sessionSecret: string;

  /**
   * Server-side session state. Logout revokes here rather than only clearing a
   * cookie, so a stolen bearer stops working the moment the admin logs out.
   */
  private readonly revoked = new Set<string>();
  private readonly lastSeen = new Map<string, number>();

  constructor(config: ConfigService<Env, true>) {
    this.adminEmail = config.get('ADMIN_EMAIL', { infer: true });
    this.passwordHash = config.get('ADMIN_PASSWORD_HASH', { infer: true });
    this.sessionSecret = config.get('SESSION_SECRET', { infer: true });

    if (!this.passwordHash) {
      // Degraded rather than fatal, matching the provider-key philosophy: the
      // process boots, and the admin surface reports that it is unconfigured.
      this.logger.warn(
        'ADMIN_PASSWORD_HASH is not set. All admin logins will be refused. '
        + 'Generate one with `pnpm hash-password`.',
      );
    }
  }

  get configured(): boolean {
    return this.passwordHash !== undefined;
  }

  /**
   * Constant-time on both halves.
   *
   * The email is compared with an HMAC-of-input comparison so that a mismatched
   * length does not short-circuit, and the password verify always runs — even
   * when the email is wrong — so response time does not reveal whether the
   * address exists.
   */
  async login(email: string, password: string): Promise<string> {
    if (!this.passwordHash) {
      throw new UnauthorizedException(GENERIC_FAILURE);
    }

    const emailMatches = constantTimeEqual(
      normaliseEmail(email),
      normaliseEmail(this.adminEmail),
    );

    // Always verify, so a bad email costs the same as a bad password.
    let passwordMatches = false;
    try {
      passwordMatches = await argon2.verify(this.passwordHash, password);
    } catch {
      passwordMatches = false;
    }

    if (!emailMatches || !passwordMatches) {
      throw new UnauthorizedException(GENERIC_FAILURE);
    }

    return this.issue(this.adminEmail);
  }

  issue(email: string): string {
    const now = Date.now();
    const session: AdminSession = {
      email,
      issuedAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
      jti: randomBytes(16).toString('hex'),
    };
    this.lastSeen.set(session.jti, now);
    const payload = Buffer.from(JSON.stringify(session), 'utf8').toString('base64url');
    return `${payload}.${this.sign(payload)}`;
  }

  /** Returns the session, or throws. Also enforces the idle timeout. */
  verify(bearer: string | undefined): AdminSession {
    if (!bearer) throw new UnauthorizedException('Not authenticated.');

    const [payload, signature] = bearer.split('.');
    if (!payload || !signature) throw new UnauthorizedException('Not authenticated.');
    if (!constantTimeEqual(signature, this.sign(payload))) {
      throw new UnauthorizedException('Not authenticated.');
    }

    let session: AdminSession;
    try {
      session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as AdminSession;
    } catch {
      throw new UnauthorizedException('Not authenticated.');
    }

    const now = Date.now();
    if (session.expiresAt <= now) throw new UnauthorizedException('Session expired.');
    if (this.revoked.has(session.jti)) throw new UnauthorizedException('Session ended.');

    const seen = this.lastSeen.get(session.jti) ?? session.issuedAt;
    if (now - seen > IDLE_TIMEOUT_MS) {
      this.revoked.add(session.jti);
      throw new UnauthorizedException('Session expired through inactivity.');
    }
    this.lastSeen.set(session.jti, now);

    return session;
  }

  /** Clears server-side state, not just the cookie. */
  logout(bearer: string | undefined): void {
    if (!bearer) return;
    const [payload] = bearer.split('.');
    if (!payload) return;
    try {
      const session = JSON.parse(
        Buffer.from(payload, 'base64url').toString('utf8'),
      ) as AdminSession;
      this.revoked.add(session.jti);
      this.lastSeen.delete(session.jti);
    } catch {
      // Nothing to revoke.
    }
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.sessionSecret).update(payload).digest('base64url');
  }
}

const normaliseEmail = (email: string): string => email.trim().toLowerCase();

/**
 * Length-independent constant-time compare. Digests both sides first so that
 * `timingSafeEqual` always receives equal-length buffers — comparing raw inputs
 * throws on a length mismatch, which is itself an oracle.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const digest = (value: string): Buffer =>
    createHmac('sha256', 'constant-time-compare').update(value, 'utf8').digest();
  return timingSafeEqual(digest(a), digest(b));
}
