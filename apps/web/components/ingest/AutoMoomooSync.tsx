'use client';

import { useEffect } from 'react';

// ページ読込時に 1 回だけ /api/ingest/moomoo/today を叩いて当日分を取り込む。
// polling は行わない。失敗時はサイレント (OpenD 未起動でも UI をブロックしない)。
export default function AutoMoomooSync() {
  useEffect(() => {
    let aborted = false;
    fetch('/api/ingest/moomoo/today', { method: 'POST' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (aborted || !j) return;
        if (j.totalNew > 0) {
          console.info(`[moomoo auto-sync] +${j.totalNew} new deals (dup ${j.totalDup})`);
        }
      })
      .catch((e) => {
        console.warn('[moomoo auto-sync] failed silently:', e);
      });
    return () => {
      aborted = true;
    };
  }, []);
  return null;
}
