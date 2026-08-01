import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { DiagnosisService } from './diagnosis.service.js';
import { skipAllExcept } from '../common/throttle-tiers.js';

/**
 * The seeded example gallery.
 *
 * Its own controller, governed by `global` only. Putting this on
 * DiagnosisController would give a public, cacheable, indexed read the `diagnose`
 * tier's 10-per-hour budget, which exists to ration model calls — the same
 * mistake that capped the shareable report.
 */
@ApiTags('examples')
@Controller('v1/examples')
@SkipThrottle(skipAllExcept('global'))
export class ExamplesController {
  constructor(private readonly diagnosis: DiagnosisService) {}

  @Get()
  @ApiOperation({ summary: 'Pre-scored sample briefs for the public gallery.' })
  list() {
    return this.diagnosis.listExamples();
  }
}
