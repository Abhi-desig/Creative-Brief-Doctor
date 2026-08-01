import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

/** Typed access to the request, including the session the guard attached. */
export const Req = createParamDecorator((_: unknown, ctx: ExecutionContext) =>
  ctx.switchToHttp().getRequest());
