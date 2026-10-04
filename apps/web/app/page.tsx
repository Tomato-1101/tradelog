// 仮置きのページ（画面は別途作る）。DB の件数だけを出す。
import { prisma } from '@/lib/db';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const [orders, execs, needsReview, unresolved, rounds, openRounds, memos, bars, events] = await Promise.all([
    prisma.paperOrder.count(),
    prisma.execution.count(),
    prisma.execution.count({ where: { priceStatus: 'NEEDS_REVIEW' } }),
    prisma.execution.count({ where: { priceStatus: 'UNRESOLVED' } }),
    prisma.round.count(),
    prisma.round.count({ where: { status: 'OPEN' } }),
    prisma.memo.count(),
    prisma.bar.count(),
    prisma.paperEventLog.count(),
  ]);
  const rows: Array<[string, number]> = [
    ['取り込んだイベント', events],
    ['ペーパー注文', orders],
    ['約定', execs],
    ['うち要確認', needsReview],
    ['うち未確定', unresolved],
    ['ラウンド', rounds],
    ['うち未決済', openRounds],
    ['メモ', memos],
    ['足', bars],
  ];
  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', padding: 24 }}>
      <h1>tradelog</h1>
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td style={{ paddingRight: 16 }}>{k}</td>
              <td style={{ textAlign: 'right' }}>{v.toLocaleString('ja-JP')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
