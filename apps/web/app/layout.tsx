import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';
import AppHeader from '@/components/layout/AppHeader';
import AutoMoomooSync from '@/components/ingest/AutoMoomooSync';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: 'tradelog — ローカルトレード復習',
  description: 'SBI / moomoo 取引履歴の取り込みとチャート復習',
};

// 初回描画前にテーマを決定して data-theme をセット (FOUC 防止)。
// next-themes に依存せず素の同期スクリプトで実現。
const themeBootScript = `
(function(){
  try {
    var t = localStorage.getItem('theme');
    if (t !== 'light' && t !== 'dark') {
      t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.dataset.theme = t;
  } catch (e) {
    document.documentElement.dataset.theme = 'light';
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="ja"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body className="min-h-full flex flex-col">
        <AppHeader />
        <AutoMoomooSync />
        <div className="flex-1">{children}</div>
      </body>
    </html>
  );
}
