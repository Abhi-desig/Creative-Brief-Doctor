-- Gallery examples.
--
-- `exampleShape` being non-null is what marks a Brief as a seeded gallery
-- example, and its value is the one-line description of the SHAPE of brief it
-- demonstrates ("a two-line Slack request"). Carrying the copy rather than a bare
-- boolean means there is one thing to keep in step instead of two.
--
-- Additive and nullable, so it applies to a populated database with no backfill:
-- every existing brief is correctly "not an example".

ALTER TABLE "Brief" ADD COLUMN "exampleShape" TEXT;

-- A plain index, deliberately, even though the only query is
-- `WHERE "exampleShape" IS NOT NULL` and a partial index would be tighter.
-- Prisma's schema language cannot express a partial index, so a `WHERE` clause
-- here would leave the schema and the database disagreeing, and the next
-- `migrate diff` would try to reconcile them by dropping this. For a handful of
-- example rows that trade is not worth making.
CREATE INDEX "Brief_exampleShape_idx" ON "Brief" ("exampleShape");
