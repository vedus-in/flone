import type { Metadata } from 'next';
import { ChevronDown } from '@untitledui/icons';
import { listUserOrgs, loadPage } from '@/lib/authz';
import { ButtonLink, Card, Field, Input, SubmitButton } from '@/components/ui';
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
    <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold tracking-tight text-primary">
          {firstRun ? "Let's set up your workspace" : 'New organization'}
        </h1>
        <p className="text-sm text-tertiary">
          {firstRun
            ? 'An organization holds your projects, boards and teammates. You can create more later.'
            : 'Organizations are separate workspaces. Nothing is shared between them.'}
        </p>
      </header>

      <Card className="p-6">
        <ActionForm
          action={createOrganization}
          className="flex flex-col gap-5"
          aria-label="New organization"
        >
          <Field
            htmlFor="org-name"
            label="Name"
            hint="We turn this into a URL, for example /orgs/acme."
          >
            <Input
              id="org-name"
              name="name"
              required
              minLength={2}
              maxLength={60}
              autoComplete="organization"
              autoFocus
              placeholder="Acme"
            />
          </Field>

          {/* Native `<details>`: Untitled UI ships no disclosure, and the browser
              already does the state, the keyboard and the ARIA for free. */}
          <details className="group">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-lg text-sm font-medium text-tertiary transition-colors hover:text-primary">
              Choose the URL yourself
              <ChevronDown
                aria-hidden="true"
                className="size-4 transition-transform duration-100 group-open:rotate-180"
              />
            </summary>
            <div className="pt-4">
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
                  autoComplete="off"
                  placeholder="acme"
                  spellCheck={false}
                />
              </Field>
            </div>
          </details>

          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton pendingLabel="Creating...">Create organization</SubmitButton>
            {!firstRun ? (
              <ButtonLink href="/orgs" color="tertiary">
                Cancel
              </ButtonLink>
            ) : null}
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
