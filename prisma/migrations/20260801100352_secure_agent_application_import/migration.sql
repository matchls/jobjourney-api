-- CreateEnum
CREATE TYPE "CreationSource" AS ENUM ('MANUAL', 'AGENT_IMPORT');

-- CreateEnum
CREATE TYPE "ImportReviewStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'REVIEWED');

-- CreateEnum
CREATE TYPE "AgentImportReceiptResult" AS ENUM ('CREATED', 'DUPLICATE');

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "agentDedupKey" TEXT,
ADD COLUMN     "agentImportMetadata" JSONB,
ADD COLUMN     "contractType" TEXT,
ADD COLUMN     "creationSource" "CreationSource" NOT NULL DEFAULT 'MANUAL',
ADD COLUMN     "importReviewStatus" "ImportReviewStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
ADD COLUMN     "importedByApiKeyId" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "uncertainFields" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "AgentApiKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentImportReceipt" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "result" "AgentImportReceiptResult" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentImportReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentApiKey_prefix_key" ON "AgentApiKey"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "AgentImportReceipt_apiKeyId_idempotencyKey_key" ON "AgentImportReceipt"("apiKeyId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Application_userId_agentDedupKey_key" ON "Application"("userId", "agentDedupKey");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_importedByApiKeyId_fkey" FOREIGN KEY ("importedByApiKeyId") REFERENCES "AgentApiKey"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentApiKey" ADD CONSTRAINT "AgentApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImportReceipt" ADD CONSTRAINT "AgentImportReceipt_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "AgentApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImportReceipt" ADD CONSTRAINT "AgentImportReceipt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentImportReceipt" ADD CONSTRAINT "AgentImportReceipt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

