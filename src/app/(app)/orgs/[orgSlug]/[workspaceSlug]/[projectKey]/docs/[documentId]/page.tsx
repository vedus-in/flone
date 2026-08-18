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
import { ImageAttachTextarea } from '@/components/image-attach';
import { Breadcrumbs, Field, Input, Prose, Separator, SubmitButton } from '@/components/ui';
import { ActionForm } from '../../../../../../action-form';
import {
  createDocument,
  deleteDocument,
  moveDocument,
  setDocumentShared,
  updateDocument,
} from '../actions';
import { DocIcon } from '../doc-icon';

/**
 * One document: the rendered page, and everything that can be done to it.
 *
 * THE LAYOUT IS THE FEATURE. A reading column (`max-w-3xl mx-auto`), a small
 * breadcrumb-and-meta line, a large title, the prose, and the child pages as
 * quiet icon links -- the shape of a Notion page, because a document is READ far
 * more often than it is operated on. Everything operational sits below a rule at
 * the foot, as ghost-text disclosures that stay out of the way until asked.
 *
 * A SERVER COMPONENT WITH NO CLIENT MODULE OF ITS OWN. Editing, moving, sharing
 * and deleting are ordinary forms behind native `<details>` disclosures, which
 * is the platform's answer to "show this only when I ask for it" -- no state, no
 * hydration, and it works before JavaScript arrives. The issue page earns its
 * click-to-edit client component by being the surface people live in all day;
 * one extra click on the rarer path buys this page zero client JS.
 *
 * The delete disclosure is also the confirmation. Its summary names the
 * descendant count, so "delete this section" cannot be a single stray click, and
 * the button behind it says exactly how much is going.
 *
 * NO AUTHZ LOADER FOR THE DOCUMENT ITSELF. The project ctx is proved from the URL
 * tuple, and the document is read out of the tree query this page was going to
 * run anyway, scoped by that project id -- so an id from another tenant is simply
 * not in the tree and 404s, exactly as a `require*` helper would make it.
 */

type Params = {
  orgSlug: string;
  workspaceSlug: string;
  projectKey: string;
  documentId: string;
};

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

/**
 * A page action: ghost text that gains a surface on hover, never a bordered box.
 * The panel behind each one opens onto a soft `bg-secondary` sheet, so an open
 * disclosure reads as one raised surface rather than a form dropped on the page.
 */
const DISCLOSURE =
  'inline-flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md px-2 py-1 text-[0.8125rem] text-tertiary transition-colors select-none hover:bg-secondary hover:text-primary [&::-webkit-details-marker]:hidden';

const PANEL = 'mt-2 flex flex-col gap-4 rounded-xl bg-secondary/40 p-4';

/**
 * A native `<select>` wearing Untitled UI's field tokens -- the same constant the
 * recurring and reminders pages declare, copied for the same reason they copy it
 * from each other: there is no shared module to hang it on, and it is one string.
 */
const SELECT_CLASS =
  'min-h-9 rounded-lg border border-primary bg-primary px-3 py-2 text-sm text-primary shadow-xs outline-focus-ring transition-colors hover:bg-primary_hover focus-visible:outline-2 focus-visible:outline-offset-2';

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
  const descendants = descendantIds(rows, document.id).size;
  // Deleting and publishing carry the same gate: neither can be taken back from
  // somebody who already has the subtree, or the link.
  const canDelete = document.createdById === ctx.user.id || atLeast(ctx.role, Role.ADMIN);
  // Absolute, and built from APP_URL rather than the request -- this string is
  // meant to be copied into a message to somebody outside the organization, and a
  // link built out of a Host header is a link an attacker can choose.
  const shareUrl = document.shareToken ? appUrl(publicDocumentPath(document.shareToken)) : null;

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-8 py-4 lg:py-10">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <Breadcrumbs>
          <Breadcrumbs.Item href={docsPath(ctx.org, ctx.project)}>Documents</Breadcrumbs.Item>
          {trail.map((crumb) =>
            crumb.id === document.id ? (
              <Breadcrumbs.Item key={crumb.id}>{crumb.title}</Breadcrumbs.Item>
            ) : (
              <Breadcrumbs.Item
                key={crumb.id}
                href={documentPath(ctx.org, ctx.project, crumb.id)}
              >
                {crumb.title}
              </Breadcrumbs.Item>
            ),
          )}
        </Breadcrumbs>
        <span className="text-xs whitespace-nowrap text-tertiary">
          {document.createdBy.name} · edited {DATE.format(document.updatedAt)}
          {shareUrl ? ' · public' : null}
        </span>
      </div>

      <h1 className="text-4xl font-bold tracking-tight text-balance text-primary">
        {document.title}
      </h1>

      {document.body ? (
        // The document reading size: a step up from the app's dense 14px, with
        // the line height prose wants. `Prose` itself is unchanged -- every other
        // caller keeps its scale.
        <Prose className="markdown-doc text-[0.9375rem] leading-7">{document.body}</Prose>
      ) : (
        <p className="text-sm text-tertiary">This page is empty. Open Edit below to write it.</p>
      )}

      {children.length > 0 ? (
        <nav aria-label="Documents inside this one" className="flex flex-col gap-px">
          {children.map((child) => (
            <Link
              key={child.id}
              href={documentPath(ctx.org, ctx.project, child.id)}
              className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 no-underline transition-colors hover:bg-secondary/60"
            >
              <DocIcon className="size-4 shrink-0 text-tertiary" />
              <span className="min-w-0 truncate text-[0.9375rem] font-medium text-primary">
                {child.title}
              </span>
            </Link>
          ))}
        </nav>
      ) : null}

      <Separator className="mt-2" />

      <div className="flex flex-col gap-1">
        <details>
          <summary className={DISCLOSURE}>Edit</summary>
          <ActionForm action={updateDocument} className={PANEL} aria-label="Edit document">
            <input type="hidden" name="documentId" value={document.id} />
            <Field htmlFor="document-title" label="Title">
              <Input
                id="document-title"
                name="title"
                isRequired
                maxLength={200}
                autoComplete="off"
                defaultValue={document.title}
              />
            </Field>
            <Field
              htmlFor="document-body"
              label="Body (Markdown)"
              hint="Paste, drop or attach an image and it uploads into this project."
            >
              {/* The same uncontrolled Markdown textarea the recurring-template
                  form uses, targeted at the PROJECT: a document has no issue, and
                  `Attachment.ticketId` is nullable for exactly this case. */}
              <ImageAttachTextarea
                target={{ projectId: ctx.project.id }}
                id="document-body"
                name="body"
                rows={20}
                maxLength={100000}
                defaultValue={document.body}
                placeholder={'## Overview\n\nWhat this is for.'}
              />
            </Field>
            <div>
              <SubmitButton size="sm">Save</SubmitButton>
            </div>
          </ActionForm>
        </details>

        <details>
          <summary className={DISCLOSURE}>New page inside</summary>
          <ActionForm
            action={createDocument}
            className={`${PANEL} flex-row flex-wrap items-end gap-3`}
            aria-label="New sub-document"
          >
            <input type="hidden" name="projectId" value={ctx.project.id} />
            <input type="hidden" name="parentId" value={document.id} />
            <Field htmlFor="child-document-title" label="Title" className="min-w-0 flex-1">
              <Input
                id="child-document-title"
                name="title"
                isRequired
                maxLength={200}
                autoComplete="off"
                placeholder="Deployment checklist"
              />
            </Field>
            <SubmitButton size="sm" color="secondary" pendingLabel="Creating...">
              Create
            </SubmitButton>
          </ActionForm>
        </details>

        <details>
          <summary className={DISCLOSURE}>Move</summary>
          <ActionForm
            action={moveDocument}
            className={`${PANEL} flex-row flex-wrap items-end gap-3`}
            aria-label="Move document"
          >
            <input type="hidden" name="documentId" value={document.id} />
            <Field htmlFor="document-parent" label="File under" className="min-w-0 flex-1">
              {/* A native `<select>`, and it CANNOT OFFER A CYCLE: `parentOptions`
                  drops this document and everything beneath it. `moveDocument`
                  checks again anyway -- a select is a suggestion, a POST body is
                  whatever the caller sent. */}
              <select
                id="document-parent"
                name="parentId"
                defaultValue={document.parentId ?? ''}
                className={`${SELECT_CLASS} w-full`}
              >
                <option value="">Top level</option>
                {parentOptions(rows, document.id).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.title}
                  </option>
                ))}
              </select>
            </Field>
            <SubmitButton size="sm" color="secondary" pendingLabel="Moving...">
              Move
            </SubmitButton>
          </ActionForm>
        </details>

        {canDelete ? (
          <details open={shareUrl !== null}>
            {/* Open when the document IS shared: "this page is public" is not
                something to hide behind a closed disclosure. */}
            <summary className={DISCLOSURE}>
              {shareUrl ? 'Shared on a public link' : 'Share on a public link'}
            </summary>
            <div className={PANEL}>
              {shareUrl ? (
                <>
                  {/* Readonly rather than plain text so it can be selected and
                      copied in one gesture, with no client component to do it. */}
                  <Input
                    id="document-share-url"
                    aria-label="Public link"
                    readOnly
                    value={shareUrl}
                  />
                  <p className="text-xs text-pretty text-tertiary">
                    Anyone with this link can read this document — the title, the body and
                    the images in it — without signing in. Documents filed inside this one
                    are not shared. Stopping breaks this link permanently; sharing again
                    makes a new one.
                  </p>
                </>
              ) : (
                <p className="text-xs text-pretty text-tertiary">
                  Makes a read-only page anyone with the link can open, no account needed.
                  Only this document: anything filed inside it stays private.
                </p>
              )}
              <ActionForm
                action={setDocumentShared}
                aria-label={shareUrl ? 'Stop sharing document' : 'Share document'}
              >
                <input type="hidden" name="documentId" value={document.id} />
                <input type="hidden" name="shared" value={shareUrl ? 'false' : 'true'} />
                <SubmitButton
                  size="sm"
                  color={shareUrl ? 'secondary' : 'primary'}
                  pendingLabel={shareUrl ? 'Stopping...' : 'Creating...'}
                >
                  {shareUrl ? 'Stop sharing' : 'Create a public link'}
                </SubmitButton>
              </ActionForm>
            </div>
          </details>
        ) : null}

        {canDelete ? (
          <details>
            {/* The disclosure IS the confirmation, and the count is why: deleting
                a document deletes what is filed under it, and nothing here goes
                to a trash to be recovered from. */}
            <summary className={`${DISCLOSURE} hover:text-error-primary`}>
              Delete
              {descendants > 0
                ? ` — this also deletes ${descendants} nested ${descendants === 1 ? 'document' : 'documents'}`
                : null}
            </summary>
            <ActionForm action={deleteDocument} className={PANEL} aria-label="Delete document">
              <input type="hidden" name="documentId" value={document.id} />
              <div>
                <SubmitButton size="sm" color="primary-destructive" pendingLabel="Deleting...">
                  {descendants > 0
                    ? `Delete this document and ${descendants} nested ${descendants === 1 ? 'document' : 'documents'}`
                    : 'Delete this document'}
                </SubmitButton>
              </div>
            </ActionForm>
          </details>
        ) : null}
      </div>
    </article>
  );
}
