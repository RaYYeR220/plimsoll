import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { data, display, text } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: 'Plimsoll — you cannot issue more than the room holds',
  description:
    'Tokenised notes held against the ERC-4626 vault positions behind them. When coverage falls below the line, Hedera refuses to move the money.',
};

export const viewport: Viewport = {
  themeColor: '#12100b',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${text.variable} ${data.variable}`}>
      <body>{children}</body>
    </html>
  );
}
