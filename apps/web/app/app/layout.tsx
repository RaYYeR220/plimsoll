import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppShell, type ShellLink } from '@/components/app/AppShell';
import { notes, site } from '@/site.config';

export const metadata: Metadata = {
  title: 'Plimsoll — the strongroom',
  description: 'Every note against its line, with the reading, the refusal and the record that proves it.',
};

export default function AppLayout({ children }: { children: ReactNode }) {
  const links: ShellLink[] = [
    { href: '/app', label: 'Market' },
    ...notes.map((n) => ({ href: `/app/note/${n.market.toLowerCase()}`, label: n.market })),
    { href: '/app/refusal', label: 'Refusal' },
    { href: '/app/issuer', label: 'Issuer' },
    { href: '/app/audit', label: 'Audit' },
  ];

  return (
    <AppShell links={links} topic={{ id: site.auditTopic.id, href: site.auditTopic.href }}>
      {children}
    </AppShell>
  );
}
