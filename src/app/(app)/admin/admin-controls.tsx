'use client';

import { useActionState, useRef } from 'react';
import { Table } from '@/components/application/table/table';
import { Toggle } from '@/components/base/toggle/toggle';
import { Badge, FormError, SubmitButton } from '@/components/ui';
import type { ActionResult } from '@/lib/result';
import { setRegistration, setUserAdmin } from './actions';

/**
 * The interactive half of the site administration page.
 *
 * This is the ONLY `'use client'` module in the admin slice: `page.tsx` stays a
 * Server Component that reads the database and hands plain, already-formatted
 * data down. Nothing here decides anything -- both actions re-derive the session
 * and re-check every invariant on the server. The disabled buttons below are a
 * courtesy, not a control.
 */

/** One status line per control: the error banner, or the success confirmation. */
function ActionStatus({ state }: { state: ActionResult | null }) {
  if (!state) return null;
  if (!state.ok) return <FormError>{state.error}</FormError>;
  if (!state.message) return null;
  return (
    <p role="status" className="text-xs text-tertiary">
      {state.message}
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* Registration                                                                */
/* -------------------------------------------------------------------------- */

export function RegistrationControl({ registrationEnabled }: { registrationEnabled: boolean }) {
  // `isPending` comes from `useActionState` rather than `useFormStatus` because
  // the control that needs it is not inside the form -- see the note below. It
  // is accurate here: the submit goes through a real `<form action>`, so React
  // runs the action inside a transition and tracks it.
  const [state, formAction, isPending] = useActionState<ActionResult | null, FormData>(
    setRegistration,
    null,
  );
  const formRef = useRef<HTMLFormElement>(null);

  return (
    <div className="flex flex-col gap-4">
      {/*
        This form carries the payload and nothing else. `display: contents` keeps
        it out of the layout; its only child is a hidden input, which renders no
        box at all.

        The switch is deliberately NOT inside it. react-aria wires every form
        field it owns to that form's `reset` event and restores the value the
        field had when it MOUNTED -- and React 19 resets a `<form action={fn}>`
        the moment the action settles. With the switch inside, that reset fires
        `onChange` again with the stale mount-time value, which submits a second,
        opposite toggle and silently undoes what the administrator just did.
        Outside the form there is no `form` ancestor to attach that listener to,
        and `requestSubmit()` stays the only thing that ever submits.

        `readOnly` on the hidden input is what keeps React from warning about a
        valued input with no change handler; `hidden` is not in its
        read-only-by-type list.
      */}
      <form ref={formRef} action={formAction} className="contents">
        <input
          type="hidden"
          name="enabled"
          value={registrationEnabled ? 'false' : 'true'}
          readOnly
        />
      </form>

      <div className="flex flex-wrap items-center gap-3">
        {/*
          The switch reflects the server's answer, never a local guess: it can
          only ever ask for the opposite of what was just rendered, which is
          exactly the value the hidden input above already holds. A double toggle
          during a round trip is therefore idempotent rather than corrupting.

          `isReadOnly` rather than `isDisabled` while in flight -- it blocks the
          toggle just as effectively but keeps the control focusable, so a
          keyboard user does not lose their place on every flip.
        */}
        <Toggle
          label="Allow new accounts"
          isSelected={registrationEnabled}
          isReadOnly={isPending}
          onChange={() => formRef.current?.requestSubmit()}
        />

        <Badge tone={registrationEnabled ? 'success' : 'warning'}>
          {registrationEnabled ? 'Open' : 'Closed'}
        </Badge>

        {/* ponytail: text-only pending hint. Untitled UI's `LoadingIndicator`
            starts at 32px, which is page-scale, not inline-next-to-12px-text
            scale. Swap it in if a small spinner is ever added upstream. */}
        {isPending ? <span className="text-xs text-tertiary">Saving...</span> : null}
      </div>

      <p className="text-sm text-tertiary">
        {registrationEnabled
          ? 'Anyone who reaches the sign-up page can create an account.'
          : 'The sign-up page shows a closed notice instead of the form, and the server refuses new accounts even if the form is submitted directly.'}
      </p>

      <ActionStatus state={state} />

      <p className="text-xs text-tertiary">
        One exception, on purpose: if this instance ever has no accounts at all,
        registration re-opens automatically so that a first account can be created, and
        that account becomes an administrator. Without it, closing registration on an
        empty database would lock the instance permanently.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Accounts                                                                    */
/* -------------------------------------------------------------------------- */

/** Exactly the columns the page renders -- no password hashes, no session data. */
export type AdminUserRow = {
  id: string;
  name: string;
  email: string;
  /** Preformatted on the server so the markup cannot drift between renders. */
  joinedLabel: string;
  joinedISO: string;
  isAdmin: boolean;
  /** True for the signed-in administrator's own row. */
  isSelf: boolean;
};

export function UserAdminTable({
  users,
  adminCount,
}: {
  users: AdminUserRow[];
  adminCount: number;
}) {
  // One action state for the whole table rather than one per row: each row's
  // pending state comes from its own `SubmitButton` (`useFormStatus`), while the
  // result reads as a single status line under the table instead of a message
  // wedged into a cell. Every row form holds hidden inputs only, so React's
  // post-action form reset is a no-op.
  const [state, formAction] = useActionState<ActionResult | null, FormData>(setUserAdmin, null);
  const onlyOneAdmin = adminCount <= 1;

  return (
    <div className="flex flex-col gap-4">
      <div className="w-full overflow-x-auto rounded-xl ring-1 ring-secondary">
        <Table size="sm" aria-label="Accounts on this instance">
          <Table.Header>
            <Table.Head isRowHeader>Name</Table.Head>
            <Table.Head>Email</Table.Head>
            <Table.Head>Joined</Table.Head>
            <Table.Head>Site admin</Table.Head>
            <Table.Head textValue="Actions">
              <span className="visually-hidden">Actions</span>
            </Table.Head>
          </Table.Header>

          <Table.Body
            items={users}
            dependencies={[adminCount]}
            renderEmptyState={() => (
              <span className="text-sm text-tertiary">No accounts on this instance yet.</span>
            )}
          >
            {(user) => (
              <Table.Row id={user.id} textValue={user.name}>
                <Table.Cell textValue={user.name}>
                  <span className="font-medium text-primary">{user.name}</span>
                  {user.isSelf ? <span className="ms-2 text-xs text-tertiary">you</span> : null}
                </Table.Cell>

                <Table.Cell className="text-tertiary">{user.email}</Table.Cell>

                <Table.Cell className="whitespace-nowrap text-tertiary" textValue={user.joinedLabel}>
                  <time dateTime={user.joinedISO}>{user.joinedLabel}</time>
                </Table.Cell>

                <Table.Cell textValue={user.isAdmin ? 'Yes' : 'No'}>
                  {user.isAdmin ? (
                    <Badge tone="accent">Admin</Badge>
                  ) : (
                    <span className="text-tertiary">
                      <span aria-hidden="true">&mdash;</span>
                      <span className="visually-hidden">Not an administrator</span>
                    </span>
                  )}
                </Table.Cell>

                <Table.Cell textValue={user.isAdmin ? 'Revoke admin' : 'Make admin'}>
                  <form action={formAction} className="flex justify-end">
                    <input type="hidden" name="userId" value={user.id} readOnly />
                    <input
                      type="hidden"
                      name="isAdmin"
                      value={user.isAdmin ? 'false' : 'true'}
                      readOnly
                    />
                    <SubmitButton
                      size="sm"
                      color={user.isAdmin ? 'secondary-destructive' : 'secondary'}
                      // Mirrors the two server-side invariants. The server
                      // refuses either way; this only avoids offering a click
                      // that is guaranteed to fail.
                      isDisabled={user.isAdmin && (user.isSelf || onlyOneAdmin)}
                    >
                      {user.isAdmin ? 'Revoke admin' : 'Make admin'}
                    </SubmitButton>
                  </form>
                </Table.Cell>
              </Table.Row>
            )}
          </Table.Body>
        </Table>
      </div>

      <ActionStatus state={state} />

      <p className="text-xs text-tertiary">
        Site administrators govern this instance &mdash; registration, and each other. It
        grants no access to any organization&rsquo;s projects, boards or tickets. You cannot
        revoke your own access, and the last remaining administrator cannot be removed.
      </p>
    </div>
  );
}
