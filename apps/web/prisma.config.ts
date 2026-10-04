import { defineConfig } from 'prisma/config';

// Prisma 7 設定。schema.prisma 側に url は書けないのでここで指定する。
// schema は apps/web/ から見た相対パス。
// db ファイルはリポルートの data/app.db (apps/web から ../../data/app.db)。
// ローカル専用アプリなので既定は直書き。検証用に DATABASE_URL で別の DB に向けられる（lib/db.ts と同じ）。
export default defineConfig({
  schema: '../../prisma/schema.prisma',
  migrations: {
    path: '../../prisma/migrations',
  },
  datasource: {
    url: process.env.DATABASE_URL ?? 'file:../../data/app.db',
  },
});
