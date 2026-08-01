import { PasteForm } from '@/components/paste/paste-form';

/**
 * The paste page. A server shell carrying the positioning copy, with the form
 * itself as a client island.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-12 px-5 py-16 sm:px-8 sm:py-24">
      <header className="flex flex-col gap-5">
        <h1 className="report-h1 text-balance">
          Find out what your brief is missing before the work starts
        </h1>
        <p className="report-lede max-w-2xl">
          Paste a creative brief. Get a score across five dimensions, the specific
          gaps, and a ready-to-send list of questions — phrased so you can forward
          them without anyone feeling got at.
        </p>
      </header>

      <PasteForm />

      <section className="text-muted-foreground flex flex-col gap-3 text-sm">
        <p className="text-foreground font-medium">What gets looked at</p>
        <ul className="grid gap-2 sm:grid-cols-2">
          {[
            ['Objective clarity', 'what the work is for'],
            ['Audience specificity', 'who it is for, precisely'],
            ['Message substance', 'whether there is something to say'],
            ['Constraints', 'the real boundaries'],
            ['Success metrics', 'how anyone will know it worked'],
          ].map(([name, blurb]) => (
            <li key={name} className="flex gap-2.5">
              <span
                aria-hidden="true"
                className="bg-viz-track mt-[0.55em] size-1.5 shrink-0 rounded-full"
              />
              <span className="text-pretty">
                <span className="text-foreground font-medium">{name}</span>
                {' — '}
                {blurb}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
