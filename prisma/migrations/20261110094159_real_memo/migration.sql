-- CreateTable
CREATE TABLE "RealMemo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL,
    "tagsJson" TEXT NOT NULL,
    "shotsJson" TEXT NOT NULL,
    "activeWindowTitle" TEXT,
    "captureError" TEXT,
    "rawJson" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executionId" TEXT,
    "linkDeltaMs" INTEGER,
    CONSTRAINT "RealMemo_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "RealMemo_executionId_idx" ON "RealMemo"("executionId");
