import { Module } from '@nestjs/common';
import { CapabilityGate } from './capability-gate.service.js';
import { ProviderRegistry } from './provider-registry.service.js';
import { QuotaService } from './quota.service.js';
import { PricingService } from './pricing.service.js';

/**
 * The only module that imports packages/ai. Everything downstream sees
 * ProviderRegistry and the port types, never a vendor SDK.
 */
@Module({
  providers: [ProviderRegistry, CapabilityGate, QuotaService, PricingService],
  exports: [ProviderRegistry, CapabilityGate, QuotaService, PricingService],
})
export class AiModule {}
