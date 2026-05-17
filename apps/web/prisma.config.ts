import { defineConfig } from 'prisma/config';

// Prisma 7 設定。schema.prisma 側に url は書けないのでここで指定する。
// schema は apps/web/ から見た相対パス。
// db ファイルはリポルートの data/app.db (apps/web から ../../data/app.db)。
// ローカル専用アプリなので env を介さず直書き。
export default defineConfig({
  schema: '../../prisma/schema.prisma',
  migrations: {
    path: '../../prisma/migrations',
  },
  datasource: {
    url: 'file:../../data/app.db',
  },
});
