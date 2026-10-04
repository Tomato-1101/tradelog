import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'tradelog',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
