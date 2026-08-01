import { Body, Controller, Get, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { skipAllExcept } from '../common/throttle-tiers.js';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AdminAuthGuard, type AdminRequest } from './admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';

class LoginDto extends createZodDto(
  z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(400) }).strict(),
) {}

/**
 * No signup route, no password reset route, no registration endpoint to attack.
 * Login and logout only.
 */
@ApiExcludeController()
@Controller('v1/admin/auth')
/**
 * `global` alone at the class level, and `login` opts back INTO `adminLogin`
 * below.
 *
 * The previous skip set omitted `adminLogin`, which left the 5-per-15-minutes
 * brute-force tier governing `logout` and `session` too — so the sixth session
 * check locked an admin out of their own panel for a quarter of an hour. The tier
 * has to apply to the route that takes a password and to nothing else.
 */
@SkipThrottle(skipAllExcept('global'))
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  // Its own tier: 5 attempts per 15 minutes per IP. The explicit `false` is what
  // re-enables it — a handler-level skip value overrides the class-level one
  // (Reflector.getAllAndOverride returns the first non-undefined), so without
  // this line the class's `adminLogin: true` would skip brute-force protection on
  // the one route that needs it. @Throttle alone would NOT be enough: the guard
  // checks the skip key before it reads the limit.
  @SkipThrottle({ adminLogin: false })
  @Throttle({ adminLogin: { limit: 5, ttl: 15 * 60 * 1000 } })
  @HttpCode(200)
  async login(@Body() dto: LoginDto) {
    const bearer = await this.auth.login(dto.email, dto.password);
    return { bearer };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@Headers('authorization') authorization?: string): void {
    // Clears server-side state, not just the cookie.
    this.auth.logout(authorization?.replace(/^Bearer\s+/i, ''));
  }

  @Get('session')
  @UseGuards(AdminAuthGuard)
  session(@Headers('authorization') authorization: string) {
    const session = this.auth.verify(authorization.replace(/^Bearer\s+/i, ''));
    return { email: session.email, expiresAt: new Date(session.expiresAt).toISOString() };
  }
}
