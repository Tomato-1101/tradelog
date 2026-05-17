-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ImportBatch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "accountId" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "fileName" TEXT,
    "fileSha256" TEXT,
    "importedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "dupCount" INTEGER NOT NULL DEFAULT 0,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ImportBatch_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ImportBatch" ("accountId", "dupCount", "fileName", "fileSha256", "id", "importedAt", "newCount", "source") SELECT "accountId", "dupCount", "fileName", "fileSha256", "id", "importedAt", "newCount", "source" FROM "ImportBatch";
DROP TABLE "ImportBatch";
ALTER TABLE "new_ImportBatch" RENAME TO "ImportBatch";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
