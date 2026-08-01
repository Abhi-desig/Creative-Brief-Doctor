import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { skipAllExcept } from '../common/throttle-tiers.js';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { Response } from 'express';
import { Subject, catchError, finalize, from, map, merge, of, takeUntil, type Observable } from 'rxjs';
import { HttpException } from '@nestjs/common';
import { DiagnosisService, MAX_BRIEF_CHARS } from './diagnosis.service.js';
import { keepAlive, SSE_HEADERS } from '../common/sse.js';

/**
 * Three endpoints, not one, for two concrete reasons: the shareable URL has to
 * be a plain GET any stakeholder can open, and EventSource is GET-only and
 * cannot send headers — so the brief text cannot ride the streaming request.
 * POST first, stream by id.
 */

class CreateBriefDto extends createZodDto(
  z
    .object({
      // Hard char cap rejected at the DTO, before any API call is made. This is
      // the cheapest step of the admission gate.
      text: z.string().min(40).max(MAX_BRIEF_CHARS),
      title: z.string().max(200).optional(),
      requester: z.string().max(120).optional(),
    })
    .strict(),
) {}

@ApiTags('briefs')
@Controller('v1/briefs')
// Only the diagnose tier governs these routes — plus `global` as the catch-all.
// Every configured throttler applies to every route by default, so without this
// the 5-per-15-minutes admin-login tier would throttle public scoring after five
// briefs. Built from `skipAllExcept` rather than a literal so adding a tier
// cannot silently start governing public scoring.
@SkipThrottle(skipAllExcept('diagnose', 'global'))
export class DiagnosisController {
  constructor(private readonly diagnosis: DiagnosisService) {}

  @Post()
  @ApiOperation({ summary: 'Persist a brief and return its public id.' })
  @Throttle({ diagnose: { limit: 10, ttl: 60 * 60 * 1000 } })
  async create(@Body() dto: CreateBriefDto) {
    return this.diagnosis.createBrief({
      text: dto.text,
      ...(dto.title !== undefined ? { title: dto.title } : {}),
      ...(dto.requester !== undefined ? { requester: dto.requester } : {}),
    });
  }

  /**
   * Governed by `global` (300/min) alone.
   *
   * This handler inherited the class's `diagnose` tier — 10 per HOUR — which is
   * the budget for spending a generation, applied to a plain read that spends
   * nothing. The endpoint exists precisely so any stakeholder can open the link,
   * and it was capped at ten opens an hour. Worse: the web app's `fetchReport`
   * forwards no `x-forwarded-for`, so with `trust proxy` on, every reader on
   * earth was attributed to the single Next server IP and shared one bucket. The
   * forwarding is fixed in apps/web/lib/api.ts; the tier is fixed here.
   */
  @Get(':publicId')
  @ApiOperation({ summary: 'The shareable report. Server-rendered by the web app.' })
  @SkipThrottle({ diagnose: true })
  async get(@Param('publicId') publicId: string) {
    return this.diagnosis.getReport(publicId);
  }

  /**
   * Coarse status events only, never partial JSON.
   *
   * Four things silently break SSE, and all four are handled:
   *
   *   1. Global interceptors. A `timeout()` interceptor kills the stream and a
   *      transform interceptor corrupts the frames. Streaming routes are
   *      excluded in main.ts by path.
   *   2. `compression` middleware buffers SSE. Disabled on this path in main.ts.
   *   3. Reverse proxies buffer. `X-Accel-Buffering: no` is set below.
   *   4. Nest emits no keepalives and idle connections get reaped. A ping is
   *      merged into the observable.
   *
   * Abort propagation is a conformance requirement, not an implementation
   * detail: `finalize` aborts the controller on client disconnect, and the signal
   * is threaded all the way to the adapter's fetch. On a free tier an ignored
   * abort burns shared quota, which is worse than burning money.
   */
  @Sse(':publicId/diagnose/stream')
  @Throttle({ diagnose: { limit: 10, ttl: 60 * 60 * 1000 } })
  diagnose(
    @Param('publicId') publicId: string,
    @Res({ passthrough: true }) response: Response,
  ): Observable<MessageEvent> {
    for (const [header, value] of Object.entries(SSE_HEADERS)) {
      response.setHeader(header, value);
    }
    // Express's compression middleware honours this, so the stream is not
    // buffered even if compression is registered globally later.
    response.setHeader('Content-Encoding', 'identity');

    const controller = new AbortController();
    // Signals the keepalive to stop. Without it `merge` never completes, because
    // an interval never completes — the connection would hang open forever after
    // the result had already been delivered.
    const done = new Subject<void>();

    const events = from(this.diagnosis.runStreaming(publicId, controller.signal)).pipe(
      map((event) => ({ type: event.type, data: event.data }) as MessageEvent),
      /**
       * A thrown error must reach the browser as a terminal `event: error`
       * frame, not as an abruptly closed connection — an EventSource treats a
       * dropped connection as something to RECONNECT to, so an unmapped error
       * would silently retry the whole diagnosis.
       */
      catchError((error: unknown) =>
        of({ type: 'error', data: toErrorFrame(error) } as MessageEvent)),
      finalize(() => done.next()),
    );

    // Nest auto-unsubscribes on client disconnect, and finalize is the
    // documented cleanup hook — so closing the tab aborts the upstream request.
    return merge(events, keepAlive().pipe(takeUntil(done)))
      .pipe(finalize(() => controller.abort()));
  }
}

/** The wire contract: `{ code, message }`, never a stack or a vendor message. */
function toErrorFrame(error: unknown): { code: string; message: string } {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'object' && response !== null) {
      const body = response as { code?: string; message?: string };
      return {
        code: body.code ?? String(error.getStatus()),
        message: body.message ?? 'Scoring failed.',
      };
    }
    return { code: String(error.getStatus()), message: String(response) };
  }
  const withKind = error as { kind?: string; message?: string };
  return {
    code: (withKind.kind ?? 'UPSTREAM').toUpperCase(),
    message: withKind.message ?? 'Scoring failed.',
  };
}
