-- AlterTable
ALTER TABLE "Memo" ADD COLUMN "replayRecordingId" TEXT;
ALTER TABLE "Memo" ADD COLUMN "replaySessionId" TEXT;
ALTER TABLE "Memo" ADD COLUMN "replayVideoMs" INTEGER;

-- AlterTable
ALTER TABLE "PaperOrder" ADD COLUMN "replayRecordingId" TEXT;
ALTER TABLE "PaperOrder" ADD COLUMN "replaySessionId" TEXT;
ALTER TABLE "PaperOrder" ADD COLUMN "replayVideoMs" INTEGER;
