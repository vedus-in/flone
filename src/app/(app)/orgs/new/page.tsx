import type { Metadata } from 'next';
import { Card } from '@heroui/react/card';
import { Description } from '@heroui/react/description';
import { Disclosure } from '@heroui/react/disclosure';
import { listUserOrgs, loadPage } from '@/lib/authz';
import { ButtonLink, Input, Label, SubmitButton, TextField } from '@/components/ui';
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
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {firstRun ? "Let's set up your workspace" : 'New organization'}
        </h1>
        <p className="text-sm text-muted">
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
          {/* Per HeroUI v3: value-ish props belong on TextField, `name` on the Input. */}
          <TextField
            isRequired
            minLength={2}
            maxLength={60}
            autoComplete="organization"
            fullWidth
          >
            <Label>Name</Label>
            <Input name="name" autoFocus placeholder="Acme" />
            <Description>We turn this into a URL, for example /orgs/acme.</Description>
          </TextField>

          <Disclosure>
            <Disclosure.Heading level={2}>
              <Disclosure.Trigger className="flex w-full items-center justify-between gap-2 rounded-lg text-sm font-medium text-muted transition-colors hover:text-foreground">
                Choose the URL yourself
                <Disclosure.Indicator />
              </Disclosure.Trigger>
            </Disclosure.Heading>
            <Disclosure.Content>
              <Disclosure.Body>
                <TextField
                  maxLength={40}
                  pattern="[a-z0-9][a-z0-9-]{0,38}[a-z0-9]"
                  autoComplete="off"
                  fullWidth
                >
                  <Label>URL</Label>
                  <Input name="slug" placeholder="acme" spellCheck={false} />
                  <Description>
                    Leave blank to generate one. 2 to 40 lowercase letters, numbers or dashes.
                  </Description>
                </TextField>
              </Disclosure.Body>
            </Disclosure.Content>
          </Disclosure>

          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton pendingLabel="Creating...">Create organization</SubmitButton>
            {!firstRun ? (
              <ButtonLink href="/" variant="ghost">
                Cancel
              </ButtonLink>
            ) : null}
          </div>
        </ActionForm>
      </Card>
    </div>
  );
}
