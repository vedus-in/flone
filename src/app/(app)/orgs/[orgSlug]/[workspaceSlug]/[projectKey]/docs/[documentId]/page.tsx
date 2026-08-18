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
import { Breadcrumbs, Field, Input, Prose, SubmitButton } from '@/components/ui';
import { ActionForm } from '../../../../../../action-form';
import {
  createDocument,
  deleteDocument,
  moveDocument,
  setDocumentShared,
  updateDocument,
} from '../actions';

/**
 * One document: the rendered page, and everything that can be done to it.
 *
 * A SERVER COMPONENT WITH NO CLIENT MODULE OF ITS OWN. Editing, moving and
 * deleting are three ordinary forms behind three `<details>` disclosures, which
 * is the native platform answer to "show this only when I ask for it" -- no
 * state, no hydration, and it works before JavaScript arrives. The issue page
 * earns its click-to-edit client component by being the surface people live in
 * all day; a document is read far more often than it is edited, and the
 * disclosure is one extra click on the rarer path.
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

const DISCLOSURE =
  'cursor-pointer list-none rounded-lg border border-secondary px-3 py-1.5 text-[0.8125rem] text-tertiary transition-colors hover:text-primary';

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
    <div className="flex flex-col gap-6">
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

      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold text-balance text-primary">{document.title}</h1>
        <p className="text-xs text-tertiary">
          {document.createdBy.name} · updated {DATE.format(document.updatedAt)}
        </p>
      </header>

      {document.body ? (
        <Prose>{document.body}</Prose>
      ) : (
        <p className="text-sm text-tertiary">Nothing written yet.</p>
      )}

      {children.length > 0 ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium text-primary">Inside this document</h2>
          <ul className="overflow-hidden rounded-xl border border-secondary">
            {children.map((child) => (
              <li
                key={child.id}
                className="border-b border-secondary last:border-b-0 hover:bg-secondary/60"
              >
                <Link
                  href={documentPath(ctx.org, ctx.project, child.id)}
                  className="block truncate px-3 py-2 text-[0.8125rem] text-primary no-underline hover:underline"
                >
                  {child.title}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="flex flex-col gap-3">
        <details>
          <summary className={DISCLOSURE}>Edit</summary>
          <ActionForm
            action={updateDocument}
            className="mt-3 flex flex-col gap-4"
            aria-label="Edit document"
          >
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
          <summary className={DISCLOSURE}>Move</summary>
          <ActionForm
            action={moveDocument}
            className="mt-3 flex flex-wrap items-end gap-3"
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

        <details>
          <summary className={DISCLOSURE}>New document inside this one</summary>
          <ActionForm
            action={createDocument}
            className="mt-3 flex flex-wrap items-end gap-3"
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

        {canDelete ? (
          <details open={shareUrl !== null}>
            {/* Open when the document IS shared: "this page is public" is not
                something to hide behind a closed disclosure. */}
            <summary className={DISCLOSURE}>
              {shareUrl ? 'Shared on a public link' : 'Share on a public link'}
            </summary>
            <div className="mt-3 flex flex-col gap-3">
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
                  <p className="text-xs text-tertiary">
                    Anyone with this link can read this document — the title, the body and
                    the images in it — without signing in. Documents filed inside this one
                    are not shared. Stopping breaks this link permanently; sharing again
                    makes a new one.
                  </p>
                </>
              ) : (
                <p className="text-xs text-tertiary">
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
            <summary className={DISCLOSURE}>
              Delete
              {descendants > 0
                ? ` — this also deletes ${descendants} nested ${descendants === 1 ? 'document' : 'documents'}`
                : null}
            </summary>
            <ActionForm action={deleteDocument} className="mt-3" aria-label="Delete document">
              <input type="hidden" name="documentId" value={document.id} />
              <SubmitButton size="sm" color="primary-destructive" pendingLabel="Deleting...">
                {descendants > 0
                  ? `Delete this document and ${descendants} nested ${descendants === 1 ? 'document' : 'documents'}`
                  : 'Delete this document'}
              </SubmitButton>
            </ActionForm>
          </details>
        ) : null}
      </div>
    </div>
  );
}
