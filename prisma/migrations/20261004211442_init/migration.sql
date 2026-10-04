-- CreateTable
CREATE TABLE "Instrument" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "symbol" TEXT NOT NULL,
    "name" TEXT,
    "market" TEXT NOT NULL DEFAULT 'TSE'
);

-- CreateTable
CREATE TABLE "PaperOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "positionId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" TEXT NOT NULL,
    "orderType" TEXT NOT NULL,
    "limitPrice" TEXT,
    "placedAt" DATETIME NOT NULL,
    "state" TEXT NOT NULL,
    "fillMarkedAt" DATETIME,
    "fillMarkId" TEXT,
    "cancelId" TEXT,
    "instrumentId" INTEGER NOT NULL,
    "rawJson" TEXT NOT NULL,
    CONSTRAINT "PaperOrder_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "instrumentId" INTEGER NOT NULL,
    "account" TEXT NOT NULL DEFAULT 'default',
    "executedAt" DATETIME NOT NULL,
    "timePrecision" TEXT NOT NULL,
    "side" TEXT NOT NULL,
    "qty" TEXT NOT NULL,
    "price" TEXT,
    "fee" TEXT NOT NULL DEFAULT '0',
    "marginType" TEXT,
    "priceStatus" TEXT NOT NULL,
    "priceBasis" TEXT,
    "priceNote" TEXT,
    "paperOrderId" TEXT,
    "dedupeHash" TEXT,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "importBatchId" TEXT,
    "roundId" TEXT,
    "rawJson" TEXT NOT NULL,
    CONSTRAINT "Execution_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Execution_paperOrderId_fkey" FOREIGN KEY ("paperOrderId") REFERENCES "PaperOrder" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Execution_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Execution_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Round" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "instrumentId" INTEGER NOT NULL,
    "account" TEXT NOT NULL,
    "marginType" TEXT,
    "direction" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    "timePrecision" TEXT NOT NULL,
    "qtyOpened" TEXT NOT NULL,
    "remainingQty" TEXT NOT NULL,
    "avgEntryPrice" TEXT,
    "avgExitPrice" TEXT,
    "remainingAvgPrice" TEXT,
    "realizedPnl" TEXT,
    "fees" TEXT NOT NULL,
    "netPnl" TEXT,
    "holdSeconds" INTEGER,
    "mae" TEXT,
    "mfe" TEXT,
    "status" TEXT NOT NULL,
    "hasUnresolved" BOOLEAN NOT NULL,
    "warningsJson" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Round_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Memo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "positionId" TEXT NOT NULL,
    "roundId" TEXT,
    "orderId" TEXT,
    "ts" DATETIME NOT NULL,
    "text" TEXT NOT NULL,
    CONSTRAINT "Memo_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "Round" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Shot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "paperOrderId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "priceText" TEXT,
    "price" TEXT,
    "symbolText" TEXT,
    "confidence" REAL,
    CONSTRAINT "Shot_paperOrderId_fkey" FOREIGN KEY ("paperOrderId") REFERENCES "PaperOrder" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Bar" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "open" REAL NOT NULL,
    "high" REAL NOT NULL,
    "low" REAL NOT NULL,
    "close" REAL NOT NULL,
    "volume" REAL NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Bar_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BarFetch" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "barCount" INTEGER NOT NULL,
    "error" TEXT,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BarFetch_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT NOT NULL,
    "format" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "newCount" INTEGER NOT NULL,
    "dupCount" INTEGER NOT NULL,
    "warnings" TEXT NOT NULL DEFAULT '[]'
);

-- CreateTable
CREATE TABLE "PaperEventLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_market_symbol_key" ON "Instrument"("market", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "PaperOrder_fillMarkId_key" ON "PaperOrder"("fillMarkId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperOrder_cancelId_key" ON "PaperOrder"("cancelId");

-- CreateIndex
CREATE INDEX "PaperOrder_positionId_idx" ON "PaperOrder"("positionId");

-- CreateIndex
CREATE INDEX "PaperOrder_placedAt_idx" ON "PaperOrder"("placedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_paperOrderId_key" ON "Execution"("paperOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_dedupeHash_key" ON "Execution"("dedupeHash");

-- CreateIndex
CREATE INDEX "Execution_instrumentId_executedAt_idx" ON "Execution"("instrumentId", "executedAt");

-- CreateIndex
CREATE INDEX "Execution_roundId_idx" ON "Execution"("roundId");

-- CreateIndex
CREATE INDEX "Round_source_openedAt_idx" ON "Round"("source", "openedAt");

-- CreateIndex
CREATE INDEX "Round_closedAt_idx" ON "Round"("closedAt");

-- CreateIndex
CREATE INDEX "Memo_positionId_idx" ON "Memo"("positionId");

-- CreateIndex
CREATE UNIQUE INDEX "Shot_paperOrderId_key" ON "Shot"("paperOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "Bar_instrumentId_timeframe_ts_key" ON "Bar"("instrumentId", "timeframe", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "BarFetch_instrumentId_timeframe_date_key" ON "BarFetch"("instrumentId", "timeframe", "date");
