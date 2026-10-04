import type { Metadata } from 'next';
import './globals.css';
import { prisma } from '@/lib/db';
import { pendingExecutionCount } from '@/lib/review/queries';

export const metadata: Metadata = {
  title: 'tradelog',
};

// 件数バッジに DB を読むので、リクエストごとに描画する
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pending = await pendingExecutionCount(prisma);
  return (
    <html lang="ja">
      <body>
        <header className="top">
          <span className="brand">tradelog</span>
          <a href="/">取引</a>
          <a href="/stats">集計</a>
          <a href="/review">
            要確認{pending > 0 && <span className="badge">{pending}</span>}
          </a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
