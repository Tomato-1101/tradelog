// 初期データを投入。Broker (SBI, MOOMOO) と デフォルト Account を upsert。
// CWD = apps/web から実行する想定 (npm run db:seed)。
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import path from 'node:path';
import { PrismaClient } from '../generated/prisma/client';

const DB_URL = `file:${path.resolve(process.cwd(), '../../data/app.db')}`;
const prisma = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: DB_URL }) });

async function main() {
  const sbi = await prisma.broker.upsert({
    where: { code: 'SBI' },
    create: { code: 'SBI', name: 'SBI 証券' },
    update: { name: 'SBI 証券' },
  });
  const moomoo = await prisma.broker.upsert({
    where: { code: 'MOOMOO' },
    create: { code: 'MOOMOO', name: 'moomoo 証券' },
    update: { name: 'moomoo 証券' },
  });

  await prisma.account.upsert({
    where: { brokerId_externalId: { brokerId: sbi.id, externalId: 'default' } },
    create: { brokerId: sbi.id, externalId: 'default', label: 'SBI メイン', baseCcy: 'JPY' },
    update: { label: 'SBI メイン', baseCcy: 'JPY' },
  });
  await prisma.account.upsert({
    where: { brokerId_externalId: { brokerId: moomoo.id, externalId: 'default' } },
    create: { brokerId: moomoo.id, externalId: 'default', label: 'moomoo メイン', baseCcy: 'USD' },
    update: { label: 'moomoo メイン', baseCcy: 'USD' },
  });

  const brokers = await prisma.broker.findMany({ include: { accounts: true } });
  console.log('Seeded brokers:');
  for (const b of brokers) {
    console.log(`  ${b.code} (${b.name}) — ${b.accounts.length} account(s)`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
