import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaClient } from '@/generated/prisma/client';
import path from 'node:path';

// Prisma 7 + SQLite + better-sqlite3 アダプタ。
// 接続 URL は prisma.config.ts と統一して apps/web から ../../data/app.db。
const DB_FILE = process.env.DATABASE_URL
  ?? `file:${path.resolve(process.cwd(), '../../data/app.db')}`;

declare global {
  var __prisma: PrismaClient | undefined;
}

function createClient() {
  const adapter = new PrismaBetterSqlite3({ url: DB_FILE });
  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma = globalThis.__prisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__prisma = prisma;
}
