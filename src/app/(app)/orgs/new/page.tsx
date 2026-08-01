import type { Metadata } from 'next';
import Link from 'next/link';
import { listUserOrgs, loadPage } from '@/lib/authz';
import { Field, Input, SubmitButton } from '@/components/ui';
import { ActionForm } from '../../action-form';
import { createOrganization } from './actions';

export const metadata: Metadata = { title: 'New organization' };

/**
 * SPEC 5 empty states: first-run copy when the user belongs to nothing yet,
 * plain copy otherwise. The distinction is driven by the membership count, which
 * is the caller's own data -- no cross-tenant read.
 */
export default async function NewOrganizationPage() {
  const orgs = await loadPage(() => listUserOrgs());
  const firstRun = orgs.length === 0;

  return (
    <div className="container container-narrow">
      <div className="stack">
        <div className="stack-sm">
          <h1>{firstRun ? "Let's set up your workspace" : 'New organization'}</h1>
          <p className="muted">
            {firstRun
              ? 'An organization holds your projects, boards and teammates. You can create more later.'
              : 'Organizations are separate workspaces. Nothing is shared between them.'}
          </p>
        </div>

        <div className="card">
          <ActionForm action={createOrganization} className="stack" aria-label="New organization">
            <Field
              htmlFor="org-name"
              label="Name"
              hint="We will turn this into a URL, for example /orgs/acme."
            >
              <Input
                id="org-name"
                name="name"
                required
                minLength={2}
                maxLength={60}
                autoFocus
                autoComplete="organization"
                placeholder="Acme"
              />
            </Field>

            <details>
              <summary>Advanced: choose a URL</summary>
              <Field
                htmlFor="org-slug"
                label="URL"
                hint="Leave blank to generate one. 2 to 40 lowercase letters, numbers or dashes."
              >
                <Input
                  id="org-slug"
                  name="slug"
                  maxLength={40}
                  pattern="[a-z0-9][a-z0-9-]{0,38}[a-z0-9]"
                  placeholder="acme"
                  autoComplete="off"
                  spellCheck={false}
                />
              </Field>
            </details>

            <div className="row">
              <SubmitButton pendingLabel="Creating...">Create organization</SubmitButton>
              {!firstRun ? (
                <Link href="/" className="btn btn-ghost">
                  Cancel
                </Link>
              ) : null}
            </div>
          </ActionForm>
        </div>
      </div>
    </div>
  );
}
