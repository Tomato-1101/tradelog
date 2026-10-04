'use client';
// 発注時スクショ。サムネイルをクリックで拡大（dialog）。

import { useEffect, useRef, useState } from 'react';

export type ShotItem = { url: string; caption: string };

export default function ShotGallery({ items }: { items: ShotItem[] }) {
  const [open, setOpen] = useState<number | null>(null);
  const dlg = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dlg.current;
    if (!d) return;
    if (open !== null && !d.open) d.showModal();
    if (open === null && d.open) d.close();
  }, [open]);
  if (items.length === 0) return <div className="empty">発注時のスクショはありません</div>;
  const cur = open !== null ? items[open] : null;
  return (
    <>
      <div className="shots">
        {items.map((s, i) => (
          <button key={s.url} type="button" className="shot" onClick={() => setOpen(i)} aria-label={`拡大: ${s.caption}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={s.url} alt={s.caption} loading="lazy" />
            <span className="cap">{s.caption}</span>
          </button>
        ))}
      </div>
      <dialog ref={dlg} onClose={() => setOpen(null)} onClick={() => setOpen(null)}>
        {cur && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={cur.url} alt={cur.caption} />
            <div className="cap">{cur.caption}</div>
          </>
        )}
      </dialog>
    </>
  );
}
