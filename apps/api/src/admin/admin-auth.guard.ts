import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { Request } from 'express';
import { AdminAuthService, type AdminSession } from './admin-auth.service.js';

export interface AdminRequest extends Request {
  adminSession?: AdminSession;
}

/**
 * The real gate on /v1/admin/*.
 *
 * Next.js middleware also gates /admin/* in the browser, but that is the
 * convenience gate — it protects the UI. This protects the data, and it is the
 * only one that matters if someone finds the API hostname.
 */
@Injectable()
export class AdminAuthGuard implements CanActivate {
  constructor(private readonly auth: AdminAuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Not authenticated.');
    }
    request.adminSession = this.auth.verify(header.slice('Bearer '.length).trim());
    return true;
  }
}
