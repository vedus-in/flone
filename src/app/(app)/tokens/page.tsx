import { headers } from 'next/headers';

import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRoot,
  TableRow,
} from '@/components/table';
import { loadPage, requireUser } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { PageBar, PageBody } from '@/components/page-bar';
import { Badge, PageHeader, SubmitButton } from '@/components/ui';
import { ActionForm } from '../action-form';
import { McpSetup } from './mcp-setup';
import { revokeSession } from './actions';

/**
 * MCP access — mint a token, see what is live, revoke anything.
 *
 * The token is a session token, so this page doubles as the account's session
 * list: a browser sign-in and an MCP client are the same kind of credential and
 * are revoked the same way.
 */

const STAMP = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export default async function TokensPage() {
  const user = await loadPage(() => requireUser());

  const sessions = await prisma.session.findMany({
    where: { userId: user.id, expiresAt: { gt: new Date() } },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    select: { id: true, createdAt: true, expiresAt: true },
  });

  // Display only: echoed into the config snippet below so it can be copied
  // verbatim. Nothing is decided from it.
  const requestHeaders = await headers();
  const host = requestHeaders.get('host') ?? 'localhost:3000';
  const proto =
    requestHeaders.get('x-forwarded-proto') ??
    (process.env.NODE_ENV === 'production' ? 'https' : 'http');
  const endpoint = `${proto}://${host}/api/mcp`;

  return (
    <>
      <PageBar crumbs={[{ label: 'MCP access' }]} />
      <PageBody width="wide" className="flex flex-col gap-8">
        <PageHeader
          title="MCP access"
          description="Let an AI assistant read and update your boards through the Model Context Protocol."
        />

        <McpSetup endpoint={endpoint} />

        <section className="flex flex-col gap-4" aria-labelledby="sessions-heading">
          <h2 id="sessions-heading" className="text-sm font-medium text-primary">
            Active sessions and tokens
          </h2>

          <div className="w-full overflow-x-auto rounded-xl ring-1 ring-secondary">
            <TableRoot size="sm" aria-label="Your active sessions and tokens">
              <TableHeader>
                <TableHead isRowHeader className="w-full">
                  Created
                </TableHead>
                <TableHead className="whitespace-nowrap">Expires</TableHead>
                <TableHead className="whitespace-nowrap text-end">Revoke</TableHead>
              </TableHeader>

              <TableBody>
                {sessions.map((session) => {
                  const isCurrent = session.id === user.sessionId;
                  return (
                    <TableRow key={session.id} id={session.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2 py-1">
                          <span className="text-primary tabular-nums">
                            {STAMP.format(session.createdAt)}
                          </span>
                          {isCurrent ? <Badge tone="accent">This browser</Badge> : null}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap align-middle text-tertiary tabular-nums">
                        {STAMP.format(session.expiresAt)}
                      </TableCell>
                      <TableCell className="align-middle">
                        <ActionForm
                          action={revokeSession}
                          className="flex justify-end"
                          aria-label={`Revoke the session created ${STAMP.format(session.createdAt)}`}
                        >
                          <input type="hidden" name="sessionId" value={session.id} />
                          <SubmitButton
                            color="secondary-destructive"
                            size="sm"
                            pendingLabel="Revoking..."
                          >
                            {isCurrent ? 'Sign out' : 'Revoke'}
                          </SubmitButton>
                        </ActionForm>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </TableRoot>
          </div>

          <p className="max-w-prose text-xs text-tertiary">
            A token is indistinguishable from a browser sign-in here, so revoke anything you do not
            recognise — the newest row is the one you just created.
          </p>
        </section>
      </PageBody>
    </>
  );
}
