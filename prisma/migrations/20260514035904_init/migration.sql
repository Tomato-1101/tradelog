-- CreateTable
CREATE TABLE "Broker" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Account" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "brokerId" INTEGER NOT NULL,
    "externalId" TEXT NOT NULL,
    "label" TEXT,
    "baseCcy" TEXT NOT NULL,
    CONSTRAINT "Account_brokerId_fkey" FOREIGN KEY ("brokerId") REFERENCES "Broker" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Instrument" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    "exchange" TEXT,
    "name" TEXT,
    "ccy" TEXT NOT NULL,
    "underlying" TEXT,
    "expiry" DATETIME,
    "strike" DECIMAL,
    "right" TEXT,
    "multiplier" INTEGER,
    "occSymbol" TEXT
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "fileName" TEXT,
    "fileSha256" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "dupCount" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "ImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Execution" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accountId" INTEGER NOT NULL,
    "instrumentId" INTEGER NOT NULL,
    "importBatchId" TEXT NOT NULL,
    "executedAt" DATETIME NOT NULL,
    "side" TEXT NOT NULL,
    "qty" DECIMAL NOT NULL,
    "price" DECIMAL NOT NULL,
    "fee" DECIMAL NOT NULL DEFAULT 0,
    "tax" DECIMAL NOT NULL DEFAULT 0,
    "marginType" TEXT NOT NULL DEFAULT 'CASH',
    "externalOrderId" TEXT,
    "externalFillId" TEXT,
    "fxRateToJpy" DECIMAL NOT NULL,
    "dedupeHash" TEXT NOT NULL,
    "rawJson" TEXT NOT NULL,
    CONSTRAINT "Execution_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Execution_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Execution_importBatchId_fkey" FOREIGN KEY ("importBatchId") REFERENCES "ImportBatch" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Round" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "accountId" INTEGER NOT NULL,
    "marginType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL,
    "closedAt" DATETIME,
    "qtyOpened" DECIMAL NOT NULL,
    "avgEntryPrice" DECIMAL NOT NULL,
    "realizedPnl" DECIMAL NOT NULL,
    "realizedPnlJpy" DECIMAL NOT NULL,
    "feesTotal" DECIMAL NOT NULL,
    "holdSeconds" INTEGER,
    "rMultiple" DECIMAL,
    "executionsJson" TEXT NOT NULL,
    "recomputedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Round_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OhlcBar" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "instrumentId" INTEGER NOT NULL,
    "timeframe" TEXT NOT NULL,
    "ts" DATETIME NOT NULL,
    "open" DECIMAL NOT NULL,
    "high" DECIMAL NOT NULL,
    "low" DECIMAL NOT NULL,
    "close" DECIMAL NOT NULL,
    "volume" DECIMAL NOT NULL,
    "source" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OhlcBar_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "FxRate" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pair" TEXT NOT NULL,
    "date" DATETIME NOT NULL,
    "rate" DECIMAL NOT NULL,
    "source" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "UserPreference" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Broker_code_key" ON "Broker"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Account_brokerId_externalId_key" ON "Account"("brokerId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_occSymbol_key" ON "Instrument"("occSymbol");

-- CreateIndex
CREATE INDEX "Instrument_kind_symbol_idx" ON "Instrument"("kind", "symbol");

-- CreateIndex
CREATE UNIQUE INDEX "Instrument_kind_symbol_expiry_strike_right_key" ON "Instrument"("kind", "symbol", "expiry", "strike", "right");

-- CreateIndex
CREATE UNIQUE INDEX "Execution_dedupeHash_key" ON "Execution"("dedupeHash");

-- CreateIndex
CREATE INDEX "Execution_instrumentId_executedAt_idx" ON "Execution"("instrumentId", "executedAt");

-- CreateIndex
CREATE INDEX "Execution_accountId_executedAt_idx" ON "Execution"("accountId", "executedAt");

-- CreateIndex
CREATE INDEX "Round_instrumentId_openedAt_idx" ON "Round"("instrumentId", "openedAt");

-- CreateIndex
CREATE INDEX "Round_closedAt_idx" ON "Round"("closedAt");

-- CreateIndex
CREATE INDEX "Round_accountId_marginType_openedAt_idx" ON "Round"("accountId", "marginType", "openedAt");

-- CreateIndex
CREATE INDEX "OhlcBar_instrumentId_timeframe_ts_idx" ON "OhlcBar"("instrumentId", "timeframe", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "OhlcBar_instrumentId_timeframe_ts_key" ON "OhlcBar"("instrumentId", "timeframe", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "FxRate_pair_date_key" ON "FxRate"("pair", "date");
