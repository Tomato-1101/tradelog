-- CreateTable
CREATE TABLE "BoardOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL,
    "orderKey" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "price" TEXT,
    "qty" INTEGER,
    "pendingMs" INTEGER,
    "symbol" TEXT,
    "symbolName" TEXT,
    "boardJson" TEXT NOT NULL,
    "rawJson" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executionId" TEXT,
    "linkDeltaMs" INTEGER,
    CONSTRAINT "BoardOrder_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RealNote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ts" DATETIME NOT NULL,
    "text" TEXT NOT NULL,
    "lastOrderKey" TEXT,
    "lastOrderJson" TEXT,
    "summary" TEXT,
    "rawJson" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "executionId" TEXT,
    "linkMethod" TEXT,
    "linkDeltaMs" INTEGER,
    CONSTRAINT "RealNote_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "Execution" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "BoardOrder_orderKey_idx" ON "BoardOrder"("orderKey");

-- CreateIndex
CREATE INDEX "BoardOrder_executionId_idx" ON "BoardOrder"("executionId");

-- CreateIndex
CREATE INDEX "RealNote_executionId_idx" ON "RealNote"("executionId");
