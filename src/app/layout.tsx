import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Kanban',
    template: '%s | Kanban',
  },
  description: 'A simple, secure Kanban board for small teams.',
  robots: { index: false, follow: false },
};

/**
 * HeroUI v3 needs no provider: every component module carries `'use client'`
 * itself, so this layout -- and every page under it -- stays a Server Component.
 *
 * Dark mode is class-based, not `prefers-color-scheme`. The app ships dark by
 * default; `suppressHydrationWarning` keeps React quiet if the class is ever
 * flipped on the client before hydration.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}
