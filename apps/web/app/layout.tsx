import type { Metadata } from 'next';
import './globals.css';
import { DB_FILE, prisma } from '@/lib/db';
import { dailyAlert, dailyStatusPath, readDailyStatus } from '@/lib/daily-status';
import { pendingExecutionCount } from '@/lib/review/queries';

export const metadata: Metadata = {
  title: 'tradelog',
};

// 件数バッジに DB を読むので、リクエストごとに描画する
export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pending = await pendingExecutionCount(prisma);
  // daily（launchd で裏で回る）が失敗・一部失敗・未実行のときだけ出す。正常なら何も出さない
  const alert = dailyAlert(readDailyStatus(dailyStatusPath(DB_FILE)), new Date());
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
        {alert && (
          <div className={`daily-alert ${alert.kind}`} role="status">
            {alert.message}。再実行: <code>launchctl kickstart gui/{process.getuid?.() ?? '$(id -u)'}/com.tomato.tradelog.daily</code>
            （ログ ~/Library/Logs/tradelog/daily.log）
          </div>
        )}
        <main>{children}</main>
      </body>
    </html>
  );
}
