import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service.js';
import { KeyVaultService } from '../ai/key-vault.service.js';

@Global()
@Module({
  providers: [SettingsService, KeyVaultService],
  exports: [SettingsService, KeyVaultService],
})
export class SettingsModule {}
