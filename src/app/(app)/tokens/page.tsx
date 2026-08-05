import { headers } from 'next/headers';

import { Table } from '@/components/application/table/table';
import { loadPage, requireUser } from '@/lib/authz';
import { prisma } from '@/lib/db';
import { Badge, Card, PageHeader, SubmitButton } from '@/components/ui';
import { ActionForm } from '../action-form';
import { createMcpToken, revokeSession } from './actions';

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
    <div className="flex flex-col gap-8">
      <PageHeader
        title="MCP access"
        description="Let an AI assistant read and update your boards through the Model Context Protocol."
      />

      <section aria-labelledby="create-heading">
        <Card className="gap-4 p-6">
          <Card.Header>
            <Card.Title id="create-heading" className="text-base">
              Create a token
            </Card.Title>
            <Card.Description>
              A token has the same access as signing in: every organization you belong to, and
              everything you can do there. It is shown once, right here, and never again.
            </Card.Description>
          </Card.Header>

          <ActionForm action={createMcpToken} aria-label="Create an MCP token">
            <div className="flex flex-wrap items-center gap-2">
              <SubmitButton pendingLabel="Creating...">Create token</SubmitButton>
            </div>
          </ActionForm>

          <p className="max-w-prose text-xs text-tertiary">
            It expires 30 days after its last use, and stays alive as long as it keeps being
            used. Revoke it below at any time.
          </p>
        </Card>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="connect-heading">
        <h2 id="connect-heading" className="text-sm font-medium text-primary">
          Connect a client
        </h2>

        <Card className="gap-4 p-6">
          <p className="text-sm text-tertiary">
            One command in Claude Code, with the token you just copied:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-secondary p-4 text-xs">
            <code>{`claude mcp add --transport http kanban ${endpoint} \\\n  --header "Authorization: Bearer <your-token>"`}</code>
          </pre>

          <p className="text-sm text-tertiary">
            Or, for any client that reads a config file:
          </p>
          <pre className="overflow-x-auto rounded-lg bg-secondary p-4 text-xs">
            <code>{`{
  "mcpServers": {
    "kanban": {
      "type": "http",
      "url": "${endpoint}",
      "headers": { "Authorization": "Bearer <your-token>" }
    }
  }
}`}</code>
          </pre>
        </Card>
      </section>

      <section className="flex flex-col gap-4" aria-labelledby="sessions-heading">
        <h2 id="sessions-heading" className="text-sm font-medium text-primary">
          Active sessions and tokens
        </h2>

        <div className="w-full overflow-x-auto rounded-xl ring-1 ring-secondary">
          <Table size="sm" aria-label="Your active sessions and tokens">
            <Table.Header>
              <Table.Head isRowHeader className="w-full">
                Created
              </Table.Head>
              <Table.Head className="whitespace-nowrap">Expires</Table.Head>
              <Table.Head className="whitespace-nowrap text-end">Revoke</Table.Head>
            </Table.Header>

            <Table.Body>
              {sessions.map((session) => {
                const isCurrent = session.id === user.sessionId;
                return (
                  <Table.Row key={session.id} id={session.id}>
                    <Table.Cell>
                      <div className="flex flex-wrap items-center gap-2 py-1">
                        <span className="text-primary tabular-nums">
                          {STAMP.format(session.createdAt)}
                        </span>
                        {isCurrent ? <Badge tone="accent">This browser</Badge> : null}
                      </div>
                    </Table.Cell>
                    <Table.Cell className="whitespace-nowrap align-middle text-tertiary tabular-nums">
                      {STAMP.format(session.expiresAt)}
                    </Table.Cell>
                    <Table.Cell className="align-middle">
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
                    </Table.Cell>
                  </Table.Row>
                );
              })}
            </Table.Body>
          </Table>
        </div>

        <p className="max-w-prose text-xs text-tertiary">
          A token is indistinguishable from a browser sign-in here, so revoke anything you do not
          recognise — the newest row is the one you just created.
        </p>
      </section>
    </div>
  );
}
