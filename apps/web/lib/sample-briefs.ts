/**
 * Sample briefs for the "try one" picker.
 *
 * Grouped by SHAPE rather than by industry, because the shape is what determines
 * the score and what a first-time user is actually choosing between: they want to
 * see what happens to a brief like theirs, and "a two-line request in chat" is a
 * far more recognisable category than "SaaS" or "retail".
 *
 * These three are written for this purpose and safe to ship. The twenty briefs in
 * `tools/calibration/briefs` are gitignored, and `AI_Commercial_Briefs.txt` in
 * particular is mode 600 — real commercial material that must not be published in
 * a client bundle. Nothing here is derived from it.
 */

export interface SampleBrief {
  id: string;
  /** What shape of brief this is — the actual choice being offered. */
  label: string;
  /** Sets expectations before the score lands. */
  hint: string;
  title: string;
  requester: string;
  text: string;
}

export const SAMPLE_BRIEFS: SampleBrief[] = [
  {
    id: 'slack',
    label: 'A two-line request in chat',
    hint: 'The most common brief there is. Expect a low score and blocking questions.',
    title: 'Dashboard video',
    requester: 'Sam',
    text: [
      'hey - can you guys do a video for the new dashboard thing? nothing fancy.',
      'need it by end of month ideally. thanks!',
    ].join('\n'),
  },
  {
    id: 'mid',
    label: 'A real brief with real gaps',
    hint: 'Confident on deliverables, quiet on audience and on what should change.',
    title: 'Brand refresh',
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
    id: 'full',
    label: 'A fully specified brief',
    hint: 'What a brief looks like when it scores well — and what it still misses.',
    title: 'Renewals win-back',
    requester: 'Dan',
    text: [
      'Campaign brief — Q3 renewals win-back',
      '',
      'Objective',
      'Recover lapsed annual subscribers before the Q3 renewal window closes. We are',
      'not trying to acquire new customers with this work; acquisition is running',
      'separately and should not be muddled into it.',
      '',
      'Audience',
      'Subscribers who let an annual plan lapse in the last 6-18 months. Mostly',
      'operations managers at 50-200 person companies who originally bought the',
      'product themselves rather than through procurement. They did not leave',
      'unhappy — in exit surveys the most common reason given is "we were not using',
      'it enough to justify the renewal". The barrier is that they remember the',
      'product as it was two years ago, before the scheduling rebuild.',
      '',
      'Message',
      'The thing you found fiddly is the thing we rebuilt. Specifically: bulk',
      'scheduling now takes one action instead of eleven, and the average customer',
      'in this segment saves 4.5 hours a month (measured across 340 accounts since',
      'the rebuild shipped in January). They currently believe the product is a',
      'nice-to-have that did not earn its renewal.',
      '',
      'Constraints',
      'Email sequence (3 sends) plus a landing page. Copy and design both needed.',
      'Live by 4 August — the renewal window opens 11 August and we want a week of',
      'runway. Budget £12k including production. Must carry the new brand marks and',
      'the standard unsubscribe and data-use footer. Legal sign-off from Priya.',
      'We tried a discount-led win-back last year; it recovered volume but the',
      'recovered accounts churned again within two quarters, so discounting is off',
      'the table.',
      '',
      'Success',
      'Reactivation rate among the targeted segment. Currently 3.1% on the last',
      'comparable campaign. Target 6% within 30 days of the final send. Measured in',
      'the renewals dashboard, attributed by campaign UTM. Under 4% would tell us',
      'the rebuild story is not landing and we should stop and rethink rather than',
      'send more.',
    ].join('\n'),
  },
];
