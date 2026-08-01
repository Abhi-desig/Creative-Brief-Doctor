import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module.js';
import { DiagnosisService } from '../../src/diagnosis/diagnosis.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';

/**
 * Seeds the `/examples` gallery by scoring sample briefs through the REAL
 * pipeline, once.
 *
 * Run deliberately, never as part of `prisma db seed`:
 *
 *     pnpm --filter @cbd/api seed:examples
 *
 * Two things this gets right that a naive version would not:
 *
 *  1. IT BACKDATES `createdAt`. The daily quota counter is
 *     `count({ createdAt: { gte: startOfUtcDay() } })`, so writing six examples on
 *     deploy day would silently consume six of that day's public cap — the tool
 *     would open already partly spent, for no reason a user could see.
 *  2. IT IS IDEMPOTENT ON `publicId`. The ids are stable and derived from the
 *     sample's slug, so `/examples` links and any external link to an example
 *     report survive a reseed. Re-running skips anything already scored rather
 *     than burning quota to produce a second identical row.
 *
 * It scores through `DiagnosisService`, not a bespoke path, so an example is
 * produced by exactly the code a member of the public exercises. A gallery built
 * from a parallel implementation would drift from the product it advertises.
 */

/** Where the seeded examples are dated, well before any real traffic. */
const BACKDATED_TO = new Date('2026-01-15T12:00:00Z');

interface Sample {
  /** Becomes the publicId, so it must be stable and URL-safe. */
  slug: string;
  title: string;
  /** The one-line "what shape of brief is this" line the gallery shows. */
  shape: string;
  requester: string | null;
  text: string;
}

/**
 * Chosen to span the range rather than to flatter the tool. The two-line request
 * is first on purpose: it is the case every reader recognises.
 */
const SAMPLES: Sample[] = [
  {
    slug: 'ex-slack-request',
    title: 'Dashboard video',
    shape: 'A two-line request sent in chat — the most common brief there is.',
    requester: 'Sam',
    text: [
      'hey - can you guys do a video for the new dashboard thing? nothing fancy.',
      'need it by end of month ideally. thanks!',
    ].join('\n'),
  },
  {
    slug: 'ex-rebrand-vague',
    title: 'Brand refresh',
    shape:
      'Confident and detailed about deliverables, silent on audience and on what '
      + 'should change.',
    requester: 'Priya',
    text: [
      'Rebrand brief',
      '',
      'We need to refresh the brand. It feels dated and doesn\'t reflect where the',
      'business is going.',
      '',
      'We want something modern, bold, and premium. Something that stands out.',
      '',
      'Look at what Monzo and Oatly have done — that kind of energy.',
      '',
      'Deliverables: new logo, colours, fonts, brand guidelines, and rollout across',
      'everything.',
    ].join('\n'),
  },
  {
    slug: 'ex-event-promo',
    title: 'Summer Sessions promo',
    shape: 'Real constraints and dates, but tone words standing in for a message.',
    requester: 'Alex',
    text: [
      'Need promo for the Summer Sessions event.',
      '',
      'It\'s a music thing in the park, 14-16 August. Three stages.',
      '',
      'Want it to feel fun and summery. Get people excited.',
      '',
      'Socials mainly. Maybe some posters.',
    ].join('\n'),
  },
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });

  const prisma = app.get(PrismaService);
  const diagnosis = app.get(DiagnosisService);

  try {
    for (const sample of SAMPLES) {
      const existing = await prisma.brief.findUnique({
        where: { publicId: sample.slug },
        include: { diagnoses: { take: 1 } },
      });

      if (existing?.diagnoses.length) {
        console.log(`· ${sample.slug} already scored; skipping.`);
        continue;
      }

      const text = sample.text.trim();
      const brief = existing
        ? await prisma.brief.update({
            where: { publicId: sample.slug },
            data: { exampleShape: sample.shape, createdAt: BACKDATED_TO },
          })
        : await prisma.brief.create({
            data: {
              publicId: sample.slug,
              rawText: text,
              charCount: text.length,
              title: sample.title,
              requester: sample.requester,
              exampleShape: sample.shape,
              createdAt: BACKDATED_TO,
            },
          });

      console.log(`→ scoring ${sample.slug} …`);

      // The same generator a browser drives, drained to completion. Status events
      // are ignored; the `result` event's side effect — a persisted Diagnosis —
      // is the point.
      const controller = new AbortController();
      for await (const event of diagnosis.runStreaming(brief.publicId, controller.signal)) {
        if (event.type === 'error') throw new Error(JSON.stringify(event.data));
      }

      /**
       * Backdate the Diagnosis too, and separately: `runStreaming` writes it with
       * `now()`, so without this the row would still land inside today's quota
       * window even though the Brief is dated in January. The Brief's date is not
       * what the counter reads.
       */
      await prisma.diagnosis.updateMany({
        where: { briefId: brief.id },
        data: { createdAt: BACKDATED_TO },
      });

      console.log(`✓ ${sample.slug}`);
    }

    const total = await prisma.brief.count({ where: { exampleShape: { not: null } } });
    console.log(`\nGallery now holds ${total} example(s).`);
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
