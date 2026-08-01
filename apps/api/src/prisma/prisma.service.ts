import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Driver-adapter Prisma client.
 *
 * Deliberately NO `onModuleInit` / `$connect`. That pattern comes from older
 * docs: the client connects lazily on first query, and an eager connect only
 * moves a database outage from "first request fails" to "process will not
 * boot" — which is exactly the crash-on-boot behaviour we are removing
 * elsewhere.
 *
 * `onModuleDestroy` IS kept, because a clean disconnect on shutdown matters for
 * pooled connections on Neon and Supabase.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect().catch((error: unknown) => {
      this.logger.warn(`Prisma disconnect failed: ${String(error)}`);
    });
  }
}
