-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Dimension" AS ENUM ('OBJECTIVE_CLARITY', 'AUDIENCE_SPECIFICITY', 'MESSAGE_SUBSTANCE', 'CONSTRAINTS', 'SUCCESS_METRICS');

-- CreateEnum
CREATE TYPE "Verdict" AS ENUM ('READY', 'NEEDS_WORK', 'NOT_READY');

-- CreateEnum
CREATE TYPE "ProviderKind" AS ENUM ('GOOGLE', 'ANTHROPIC');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('UNTESTED', 'OK', 'FAILING', 'DISABLED');

-- CreateEnum
CREATE TYPE "PromptStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "StructuredMode" AS ENUM ('NATIVE_SCHEMA', 'JSON_MODE', 'PROMPT_ONLY');

-- CreateEnum
CREATE TYPE "TokenSource" AS ENUM ('NATIVE', 'ESTIMATED');

-- CreateTable
CREATE TABLE "Brief" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "rawText" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "title" TEXT,
    "requester" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Brief_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Diagnosis" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "briefId" TEXT NOT NULL,
    "overallScore" INTEGER NOT NULL,
    "verdict" "Verdict" NOT NULL,
    "summary" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "providerRequestId" TEXT,
    "promptVersionId" TEXT NOT NULL,
    "promptHash" TEXT NOT NULL,
    "rubricVersion" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "structuredOutputMode" "StructuredMode" NOT NULL,
    "degradations" JSONB NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "reasoningTokens" INTEGER NOT NULL DEFAULT 0,
    "tokenSource" "TokenSource" NOT NULL,
    "costUsd" DECIMAL(12,6),
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Diagnosis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DimensionScore" (
    "id" TEXT NOT NULL,
    "diagnosisId" TEXT NOT NULL,
    "dimension" "Dimension" NOT NULL,
    "score" INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "gaps" TEXT[],
    "evidence" TEXT[],

    CONSTRAINT "DimensionScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUpQuestion" (
    "id" TEXT NOT NULL,
    "diagnosisId" TEXT NOT NULL,
    "dimension" "Dimension" NOT NULL,
    "question" TEXT NOT NULL,
    "blocking" BOOLEAN NOT NULL,
    "rank" INTEGER NOT NULL,

    CONSTRAINT "FollowUpQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProvider" (
    "id" TEXT NOT NULL,
    "kind" "ProviderKind" NOT NULL,
    "label" TEXT NOT NULL,
    "baseUrl" TEXT,
    "keyCiphertext" BYTEA,
    "keyIv" BYTEA,
    "keyTag" BYTEA,
    "keyLast4" TEXT,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "status" "ProviderStatus" NOT NULL DEFAULT 'UNTESTED',
    "lastPingAt" TIMESTAMP(3),
    "lastPingMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSetting" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "activeProviderId" TEXT,
    "activeModel" TEXT,
    "maxTokens" INTEGER NOT NULL DEFAULT 16000,
    "temperature" DOUBLE PRECISION,
    "topP" DOUBLE PRECISION,
    "thinkingBudget" INTEGER,
    "timeoutMs" INTEGER NOT NULL DEFAULT 120000,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "tokenCeiling" INTEGER NOT NULL DEFAULT 12000,
    "dailyCallCap" INTEGER NOT NULL DEFAULT 400,
    "costCeilingUsd" DECIMAL(10,4) NOT NULL DEFAULT 0.50,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModelPricing" (
    "id" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "inputPerMTok" DECIMAL(10,4) NOT NULL,
    "outputPerMTok" DECIMAL(10,4) NOT NULL,
    "cachedReadPerMTok" DECIMAL(10,4),
    "cacheWritePerMTok" DECIMAL(10,4),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModelPricing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTemplate" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "status" "PromptStatus" NOT NULL DEFAULT 'DRAFT',
    "changeNote" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "activatedBy" TEXT,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptActivation" (
    "id" TEXT NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "previousVersionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptActivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptTestRun" (
    "id" TEXT NOT NULL,
    "promptVersionId" TEXT NOT NULL,
    "provider" "ProviderKind" NOT NULL,
    "model" TEXT NOT NULL,
    "briefText" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "rawOutput" TEXT NOT NULL,
    "parsedOutput" JSONB,
    "stopReason" TEXT NOT NULL,
    "overallScore" INTEGER,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "costUsd" DECIMAL(12,6),
    "error" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptTestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminAuditLog" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Brief_publicId_key" ON "Brief"("publicId");

-- CreateIndex
CREATE INDEX "Brief_createdAt_idx" ON "Brief"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Diagnosis_publicId_key" ON "Diagnosis"("publicId");

-- CreateIndex
CREATE INDEX "Diagnosis_briefId_idx" ON "Diagnosis"("briefId");

-- CreateIndex
CREATE INDEX "Diagnosis_provider_model_createdAt_idx" ON "Diagnosis"("provider", "model", "createdAt");

-- CreateIndex
CREATE INDEX "Diagnosis_promptVersionId_createdAt_idx" ON "Diagnosis"("promptVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "Diagnosis_createdAt_idx" ON "Diagnosis"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DimensionScore_diagnosisId_dimension_key" ON "DimensionScore"("diagnosisId", "dimension");

-- CreateIndex
CREATE INDEX "FollowUpQuestion_diagnosisId_idx" ON "FollowUpQuestion"("diagnosisId");

-- CreateIndex
CREATE UNIQUE INDEX "AiProvider_kind_label_key" ON "AiProvider"("kind", "label");

-- CreateIndex
CREATE UNIQUE INDEX "ModelPricing_provider_model_effectiveFrom_key" ON "ModelPricing"("provider", "model", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PromptTemplate_key_key" ON "PromptTemplate"("key");

-- CreateIndex
CREATE INDEX "PromptVersion_templateId_status_idx" ON "PromptVersion"("templateId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_templateId_label_key" ON "PromptVersion"("templateId", "label");

-- CreateIndex
CREATE INDEX "PromptActivation_promptVersionId_createdAt_idx" ON "PromptActivation"("promptVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "PromptTestRun_promptVersionId_createdAt_idx" ON "PromptTestRun"("promptVersionId", "createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_createdAt_idx" ON "AdminAuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "AdminAuditLog_action_createdAt_idx" ON "AdminAuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_briefId_fkey" FOREIGN KEY ("briefId") REFERENCES "Brief"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Diagnosis" ADD CONSTRAINT "Diagnosis_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DimensionScore" ADD CONSTRAINT "DimensionScore_diagnosisId_fkey" FOREIGN KEY ("diagnosisId") REFERENCES "Diagnosis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUpQuestion" ADD CONSTRAINT "FollowUpQuestion_diagnosisId_fkey" FOREIGN KEY ("diagnosisId") REFERENCES "Diagnosis"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppSetting" ADD CONSTRAINT "AppSetting_activeProviderId_fkey" FOREIGN KEY ("activeProviderId") REFERENCES "AiProvider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "PromptTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptActivation" ADD CONSTRAINT "PromptActivation_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptTestRun" ADD CONSTRAINT "PromptTestRun_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
