import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Role } from '@prisma/client';

import {
  atLeast,
  docsPath,
  documentPath,
  loadPage,
  publicDocumentPath,
  requireProjectByKey,
} from '@/lib/authz';
import { appUrl } from '@/lib/email';
import { prisma } from '@/lib/db';
import { ancestorChain, descendantIds, parentOptions } from '@/lib/documents';
import { projectCrumb } from '@/components/crumbs';
import { PageBar } from '@/components/page-bar';
import { DocIcon } from '../doc-icon';
import { DocActions, InlineDocBody, InlineDocTitle } from './doc-editor';

/**
 * One document. This file loads and authorizes; `doc-editor.tsx` owns what is
 * interactive: the title and body edit IN PLACE on click, as the issue page's
 * do, and Share and the overflow menu are Base UI popovers in the top bar --
 * breadcrumb left, actions right, which is where Notion keeps them.
 *
 * NO AUTHZ LOADER FOR THE DOCUMENT ITSELF. The project ctx is proved from the
 * URL tuple, and the document is read scoped by that project id -- so an id
 * from another tenant is simply not found and 404s, exactly as a `require*`
 * helper would make it. The client components receive ids the server chose and
 * post them back to Server Actions that re-derive everything; nothing here
 * trusts the client with more than which form it submitted.
 */

type Params = {
  orgSlug: string;
  workspaceSlug: string;
  projectKey: string;
  documentId: string;
};

const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' });

export default async function DocumentPage({ params }: { params: Promise<Params> }) {
  const { orgSlug, workspaceSlug, projectKey, documentId } = await params;
  const ctx = await loadPage(() =>
    requireProjectByKey(orgSlug, workspaceSlug, projectKey.toUpperCase()),
  );

  // The tree, for the breadcrumbs, the children list, the parent picker and the
  // descendant count. Titles only -- bodies are long, and this page renders one.
  const rows = await prisma.document.findMany({
    where: { projectId: ctx.project.id },
    orderBy: [{ title: 'asc' }, { id: 'asc' }],
    select: { id: true, parentId: true, title: true },
  });

  const document = await prisma.document.findFirst({
    // `projectId` is the tenant predicate; the URL id alone never reaches Prisma
    // unqualified (SPEC 3).
    where: { id: documentId, projectId: ctx.project.id },
    select: {
      id: true,
      parentId: true,
      title: true,
      body: true,
      createdById: true,
      shareToken: true,
      updatedAt: true,
      createdBy: { select: { name: true } },
    },
  });
  if (!document) notFound();

  const trail = ancestorChain(rows, document.id);
  const children = rows.filter((row) => row.parentId === document.id);
  // Deleting and publishing carry the same gate: neither can be taken back from
  // somebody who already has the subtree, or the link.
  const canManage = document.createdById === ctx.user.id || atLeast(ctx.role, Role.ADMIN);
  // Absolute, and built from APP_URL rather than the request -- this string is
  // meant to be copied into a message to somebody outside the organization, and a
  // link built out of a Host header is a link an attacker can choose.
  const shareUrl = document.shareToken ? appUrl(publicDocumentPath(document.shareToken)) : null;

  return (
    <>
      <PageBar
        crumbHeading={false}
        crumbs={[
          projectCrumb(ctx.org, ctx.project),
          { label: 'Documents', href: docsPath(ctx.org, ctx.project) },
          ...trail.map((crumb) =>
            crumb.id === document.id
              ? { label: crumb.title, icon: <DocIcon className="size-3.5 text-tertiary" /> }
              : { label: crumb.title, href: documentPath(ctx.org, ctx.project, crumb.id) },
          ),
        ]}
        actions={
          <>
            <span className="hidden px-1 text-xs whitespace-nowrap text-tertiary sm:block">
              Edited {DATE.format(document.updatedAt)}
            </span>
            <DocActions
              documentId={document.id}
              projectId={ctx.project.id}
              parentId={document.parentId}
              parents={parentOptions(rows, document.id).map((row) => ({
                id: row.id,
                title: row.title,
              }))}
              shareUrl={shareUrl}
              canManage={canManage}
              descendants={descendantIds(rows, document.id).size}
            />
          </>
        }
      />

      <article className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-10 sm:px-6 lg:py-16">
        <InlineDocTitle documentId={document.id} title={document.title} body={document.body} />

        <InlineDocBody
          documentId={document.id}
          title={document.title}
          body={document.body}
          projectId={ctx.project.id}
        />

        {children.length > 0 ? (
          <nav aria-label="Documents inside this one" className="flex flex-col gap-px">
            {children.map((child) => (
              <Link
                key={child.id}
                href={documentPath(ctx.org, ctx.project, child.id)}
                className="group flex h-9 items-center gap-2.5 rounded-md px-2 no-underline transition-colors hover:bg-secondary"
              >
                <DocIcon className="size-4 shrink-0 text-tertiary" />
                <span className="min-w-0 truncate text-sm font-medium text-primary">
                  {child.title}
                </span>
              </Link>
            ))}
          </nav>
        ) : null}
      </article>
    </>
  );
}
