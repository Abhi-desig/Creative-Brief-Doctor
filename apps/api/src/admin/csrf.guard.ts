import {
  ForbiddenException,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { corsOrigins, type Env } from '../config/env.schema.js';
import { constantTimeEqual } from './admin-auth.service.js';

/**
 * CSRF for admin mutations: an Origin check plus a double-submit token.
 *
 * Mutations are POST/PATCH/DELETE only — there are no mutating GETs — so a
 * cross-site form post is the shape to defend against. The token is compared in
 * constant time for the same reason the session signature is.
 */
@Injectable()
export class AdminCsrfGuard implements CanActivate {
  private readonly allowed: string[];

  constructor(config: ConfigService<Env, true>) {
    this.allowed = corsOrigins({ CORS_ORIGIN: config.get('CORS_ORIGIN', { infer: true }) } as Env);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;

    const origin = request.headers.origin;
    if (origin && !this.allowed.includes(origin)) {
      throw new ForbiddenException('Origin not allowed.');
    }

    const header = request.get('x-csrf-token');
    const cookie = readCookie(request.headers.cookie, 'csrf_token');
    if (!header || !cookie || !constantTimeEqual(header, cookie)) {
      throw new ForbiddenException('Missing or mismatched CSRF token.');
    }
    return true;
  }
}

function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}
