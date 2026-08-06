import type { ReactNode } from 'react';
import { AuthShell } from '@/components/auth-shell';

/**
 * `/invite` sits OUTSIDE the `(auth)` group deliberately.
 *
 * That group's layout redirects anyone carrying a session to `/`. An invitation
 * link is opened by someone who already has an account at least as often as by
 * someone who does not -- a colleague invited to a second organization clicks
 * the same link -- and under `(auth)` that click would silently land on the
 * dashboard with the invitation unaccepted and no explanation.
 *
 * So: same shell, no session redirect. `accept/actions.ts` handles both cases.
 */
export const dynamic = 'force-dynamic';

export default function InviteLayout({ children }: { children: ReactNode }) {
  return <AuthShell>{children}</AuthShell>;
}
