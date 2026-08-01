import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { QuotaService } from '../ai/quota.service.js';
import { skipAllExcept } from '../common/throttle-tiers.js';

/**
 * Public capacity, so the paste page can tell someone the day is closed BEFORE
 * they write a brief into the box rather than after they press the button.
 *
 * Its own controller rather than a route on DiagnosisController, because the
 * throttling is the opposite shape: that controller is governed by `diagnose`
 * (10/hour, the budget for spending a generation) and this is a counter read that
 * spends nothing and gets polled on page load.
 */
@ApiTags('quota')
@Controller('v1/quota')
@SkipThrottle(skipAllExcept('global'))
export class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  /**
   * Deliberately returns no counts — see `PublicQuota`. A state and a reset time
   * is the entire contract.
   */
  @Get()
  @ApiOperation({ summary: 'Coarse daily capacity: open, limited or closed.' })
  status() {
    return this.quota.publicStatus();
  }
}
