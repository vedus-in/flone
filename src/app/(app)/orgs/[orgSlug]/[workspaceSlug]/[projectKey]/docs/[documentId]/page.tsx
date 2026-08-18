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
 * THE ACTIONS LIVE IN THE TOP BAR, where Notion puts them: breadcrumb on the
 * left, then Edit, Share and the "⋯" menu on the right, each a native
 * `<details>` whose panel is an absolutely-positioned popover under its
 * trigger. Nothing about the page has to be scrolled past to operate on it,
 * and the reading column below stays nothing but the document.
 *
 * A SERVER COMPONENT WITH NO CLIENT MODULE OF ITS OWN. A `<details>` with an
 * `absolute` panel is the platform's popover: no state, no hydration, works
 * before JavaScript arrives. The one thing it does not give is close-on-
 * outside-click, which is the accepted cost of zero client JS on a page that
 * is read far more often than it is operated on.
 *
 * Delete lives inside the "⋯" menu and still confirms by content: the button
 * itself names the descendant count, so "delete this section" cannot be a
 * single stray click even there.
 *
 * NO AUTHZ LOADER FOR THE DOCUMENT ITSELF. The project ctx is proved from the
 * URL tuple, and the document is read scoped by that project id -- so an id
 * from another tenant is simply not found and 404s, exactly as a `require*`
 * helper would make it.
 */

type Params = {
  orgSlug: string;
  workspaceSlug: string;
  projectKey: string;
  documentId: string;
};

const DATE = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

/** A top-bar action: ghost text that gains a surface on hover. */
const ACTION =
  'inline-flex cursor-pointer list-none items-center rounded-md px-2 py-1 text-xs whitespace-nowrap text-tertiary transition-colors select-none hover:bg-secondary hover:text-primary [&::-webkit-details-marker]:hidden';

/**
 * The popover panel under a top-bar trigger. The same surface the app's
 * dropdown menus draw -- `bg-primary`, hairline border, deep shadow -- so a
 * details-based popover is indistinguishable from the scripted ones.
 */
const POPOVER_BASE =
  'absolute right-0 top-[calc(100%+0.375rem)] z-50 flex flex-col gap-4 rounded-xl border border-secondary bg-primary p-4 shadow-2xl';

const POPOVER = `${POPOVER_BASE} w-80 max-w-[calc(100vw-2rem)]`;

/** Edit wants room for the body textarea: as wide as the viewport allows, capped. */
const EDIT_POPOVER = `${POPOVER_BASE} w-[min(42rem,calc(100vw-2rem))]`;

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
      {/* The top bar: breadcrumb left, meta and every page action right. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <Breadcrumbs className="min-w-0">
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

        <div className="flex shrink-0 items-center gap-0.5">
          <span className="mr-1.5 text-xs whitespace-nowrap text-tertiary">
            Edited {DATE.format(document.updatedAt)}
          </span>

          <details className="relative">
            <summary className={ACTION}>Edit</summary>
            <ActionForm action={updateDocument} className={EDIT_POPOVER} aria-label="Edit document">
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
                  rows={16}
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

          {canDelete ? (
            <details className="relative">
              {/* The shared state is worn on the trigger, not hidden in the
                  panel: a public page says so from the top bar. */}
              <summary className={ACTION}>
                {shareUrl ? <span className="text-brand-secondary">Public</span> : 'Share'}
              </summary>
              <div className={POPOVER}>
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
                      Anyone with this link can read this document — the title, the body
                      and the images in it — without signing in. Documents filed inside
                      this one are not shared. Stopping breaks this link permanently;
                      sharing again makes a new one.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-pretty text-tertiary">
                    Makes a read-only page anyone with the link can open, no account
                    needed. Only this document: anything filed inside it stays private.
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

          <details className="relative">
            <summary className={`${ACTION} text-sm leading-none`} aria-label="More actions">
              ⋯
            </summary>
            <div className={POPOVER}>
              <ActionForm
                action={createDocument}
                className="flex flex-col gap-2"
                aria-label="New page inside this document"
              >
                <input type="hidden" name="projectId" value={ctx.project.id} />
                <input type="hidden" name="parentId" value={document.id} />
                <Field htmlFor="child-document-title" label="New page inside">
                  <Input
                    id="child-document-title"
                    name="title"
                    isRequired
                    maxLength={200}
                    autoComplete="off"
                    placeholder="Deployment checklist"
                  />
                </Field>
                <div>
                  <SubmitButton size="sm" color="secondary" pendingLabel="Creating...">
                    Create
                  </SubmitButton>
                </div>
              </ActionForm>

              <Separator />

              <ActionForm action={moveDocument} className="flex flex-col gap-2" aria-label="Move document">
                <input type="hidden" name="documentId" value={document.id} />
                <Field htmlFor="document-parent" label="Move under">
                  {/* A native `<select>`, and it CANNOT OFFER A CYCLE:
                      `parentOptions` drops this document and everything beneath
                      it. `moveDocument` checks again anyway -- a select is a
                      suggestion, a POST body is whatever the caller sent. */}
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
                <div>
                  <SubmitButton size="sm" color="secondary" pendingLabel="Moving...">
                    Move
                  </SubmitButton>
                </div>
              </ActionForm>

              {canDelete ? (
                <>
                  <Separator />
                  {/* The button IS the confirmation: it names the descendant
                      count, because deleting a document deletes what is filed
                      under it and nothing here goes to a trash. */}
                  <ActionForm action={deleteDocument} aria-label="Delete document">
                    <input type="hidden" name="documentId" value={document.id} />
                    <SubmitButton
                      size="sm"
                      color="secondary-destructive"
                      pendingLabel="Deleting..."
                    >
                      {descendants > 0
                        ? `Delete, with ${descendants} nested ${descendants === 1 ? 'page' : 'pages'}`
                        : 'Delete this document'}
                    </SubmitButton>
                  </ActionForm>
                </>
              ) : null}
            </div>
          </details>
        </div>
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
        <p className="text-sm text-tertiary">This page is empty. Open Edit above to write it.</p>
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
    </article>
  );
}
