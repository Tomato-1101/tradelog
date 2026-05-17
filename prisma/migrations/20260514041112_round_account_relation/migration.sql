-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Round" (
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
    CONSTRAINT "Round_instrumentId_fkey" FOREIGN KEY ("instrumentId") REFERENCES "Instrument" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Round_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Round" ("accountId", "avgEntryPrice", "closedAt", "direction", "executionsJson", "feesTotal", "holdSeconds", "id", "instrumentId", "marginType", "openedAt", "qtyOpened", "rMultiple", "realizedPnl", "realizedPnlJpy", "recomputedAt") SELECT "accountId", "avgEntryPrice", "closedAt", "direction", "executionsJson", "feesTotal", "holdSeconds", "id", "instrumentId", "marginType", "openedAt", "qtyOpened", "rMultiple", "realizedPnl", "realizedPnlJpy", "recomputedAt" FROM "Round";
DROP TABLE "Round";
ALTER TABLE "new_Round" RENAME TO "Round";
CREATE INDEX "Round_instrumentId_openedAt_idx" ON "Round"("instrumentId", "openedAt");
CREATE INDEX "Round_closedAt_idx" ON "Round"("closedAt");
CREATE INDEX "Round_accountId_marginType_openedAt_idx" ON "Round"("accountId", "marginType", "openedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
