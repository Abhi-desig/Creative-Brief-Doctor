-- Database-level constraints. HAND-WRITTEN — do not squash, do not regenerate.
--
-- These three rules live here rather than in service code because application
-- code gets bypassed: by a psql session, by a seed script, by a migration, and
-- by the next developer who adds a second write path. A constraint that only
-- exists in a service is a convention, not a guarantee.
--
-- Prisma cannot express any of the three, so `prisma migrate dev` will never
-- generate them and `prisma migrate diff` will not notice if they go missing.
-- If this migration is ever collapsed into a squashed baseline, re-add it
-- verbatim.
--
--   1. One ACTIVE version per template  -> partial unique index
--   2. Exactly one AppSetting row       -> CHECK (id = 'singleton')
--   3. Non-draft prompt content is      -> BEFORE UPDATE trigger
--      immutable

-- ── 1. One ACTIVE prompt version per template ───────────────────────────────
--
-- A partial unique index, not a plain unique index: many DRAFT and many
-- ARCHIVED rows per template are legal, exactly one ACTIVE is not.
--
-- This is what makes concurrent activation safe. Two transactions both trying
-- to activate a different version of the same template will serialise here and
-- one will fail with a unique violation — no advisory lock, no SELECT ... FOR
-- UPDATE, no read-modify-write window in application code.

CREATE UNIQUE INDEX "one_active_prompt_per_template"
  ON "PromptVersion" ("templateId")
  WHERE "status" = 'ACTIVE';

-- ── 2. AppSetting is a singleton ─────────────────────────────────────────────
--
-- The Prisma default of `@default("singleton")` makes the common path produce
-- one row; this makes a second row impossible even if someone supplies an
-- explicit id.

ALTER TABLE "AppSetting"
  ADD CONSTRAINT "app_setting_is_singleton"
  CHECK ("id" = 'singleton');

-- ── 3. Non-draft prompt content is immutable ─────────────────────────────────
--
-- Constitution principle 1: a prompt version's content is write-once and
-- content-hashed. Editing an ACTIVE or ARCHIVED version forks a new DRAFT
-- instead of mutating in place, because a diagnosis that cannot be attributed
-- to an exact configuration is not auditable.
--
-- Status transitions are still allowed (DRAFT -> ACTIVE -> ARCHIVED), and so
-- are the activation bookkeeping columns. Only `content` and `contentHash` are
-- frozen, and only once the row has left DRAFT.

CREATE OR REPLACE FUNCTION "prompt_version_content_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
  -- OLD.status is the status the row had BEFORE this update. A row still in
  -- DRAFT may be edited freely, including in the same statement that promotes
  -- it to ACTIVE.
  IF OLD."status" <> 'DRAFT' THEN
    IF NEW."content" IS DISTINCT FROM OLD."content" THEN
      RAISE EXCEPTION
        'PromptVersion % is %, so content is immutable. Fork a new DRAFT instead.',
        OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW."contentHash" IS DISTINCT FROM OLD."contentHash" THEN
      RAISE EXCEPTION
        'PromptVersion % is %, so contentHash is immutable.',
        OLD."id", OLD."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "prompt_version_immutable_content"
  BEFORE UPDATE ON "PromptVersion"
  FOR EACH ROW
  EXECUTE FUNCTION "prompt_version_content_is_immutable"();
