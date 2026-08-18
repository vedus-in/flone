import { notFound } from 'next/navigation';

import { findSharedDocument } from '@/lib/authz';
import { Prose } from '@/components/ui';

/**
 * A shared document: `/d/<token>`, and the ONE route in this app that renders
 * without a session.
 *
 * THE TOKEN IS THE WHOLE AUTHORIZATION. `findSharedDocument` looks a row up by it
 * and by nothing else, so an unknown token, a revoked one and a deleted document
 * are the same null and the same 404 -- there is no existence oracle here either,
 * and no id from the URL ever reaches Prisma unqualified.
 *
 * IT DELIBERATELY RENDERS ALMOST NOTHING ELSE. No organization name, no project
 * key, no author, no sidebar, no link to a sibling or child document: a link you
 * send to somebody outside the company should describe the page, not the company.
 * Children of a shared document are private until shared themselves, so there is
 * nothing here to walk into.
 *
 * Outside the `(app)` route group on purpose -- that group's layout renders the
 * application shell, which reads the session and would redirect a signed-out
 * reader to the login page.
 *
 * `robots: noindex` comes from the root layout, which sets it for the whole app.
 * A shared link is shared, not published: it should work when you send it, and
 * not turn up in a search result.
 */

export const dynamic = 'force-dynamic';

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export async function generateMetadata({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const document = await findSharedDocument(token);
  // No title for a dead link: the tab must not confirm that a document was ever
  // there, and `notFound()` below is what the reader actually sees.
  return document ? { title: document.title } : {};
}

export default async function SharedDocumentPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const document = await findSharedDocument(token);
  if (!document) notFound();

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-5 py-12">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-balance text-primary">{document.title}</h1>
        <p className="text-xs text-tertiary">
          Updated {DATE.format(document.updatedAt)}
        </p>
      </header>

      {document.body ? (
        <Prose>{document.body}</Prose>
      ) : (
        <p className="text-sm text-tertiary">This document is empty.</p>
      )}

      <footer className="border-t border-secondary pt-4 text-xs text-tertiary">
        Shared with you from Flone. You are reading a copy that its owner can revoke at any
        time.
      </footer>
    </main>
  );
}
