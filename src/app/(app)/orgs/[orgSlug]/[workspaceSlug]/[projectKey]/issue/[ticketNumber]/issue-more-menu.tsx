'use client';

/**
 * The `...` beside an issue's breadcrumb: copy its link or key, and -- for the
 * author or an admin -- delete it.
 *
 * Delete asks with the browser's own confirm, as deleting a comment does; the
 * action re-checks author-or-admin itself and redirects to the issues list.
 */

import { useState, useTransition } from 'react';
import { Button as AriaButton } from 'react-aria-components';

import { Dropdown } from '@/components/base/dropdown/dropdown';
import { IconMore } from '@/components/icons';

import { deleteIssue } from '../../issue-actions';

export function IssueMoreMenu({
  ticketId,
  issueKey,
  canDelete,
}: {
  ticketId: string;
  issueKey: string;
  canDelete: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function copy(text: string) {
    const fail = () => {
      setError('Could not copy to the clipboard.');
      window.setTimeout(() => setError(null), 4000);
    };
    // `navigator.clipboard` does not exist on an insecure origin, and then the
    // call throws rather than rejecting.
    if (!navigator.clipboard) return fail();
    navigator.clipboard.writeText(text).then(() => setError(null), fail);
  }

  function remove() {
    if (pending) return;
    if (!window.confirm(`Delete ${issueKey}? Its comments go with it; sub-issues stay. This cannot be undone.`)) return;
    const data = new FormData();
    data.set('ticketId', ticketId);
    startTransition(async () => {
      // A success redirects away; a value only comes back on failure.
      const result = await deleteIssue(null, data);
      if (result && !result.ok) setError(result.error);
    });
  }

  return (
    <span className="flex items-center gap-2">
      <Dropdown.Root>
        <AriaButton
          aria-label="Issue actions"
          className="grid size-7 place-items-center rounded-md text-tertiary transition-colors outline-focus-ring hover:bg-secondary hover:text-primary focus-visible:outline-2"
        >
          <IconMore />
        </AriaButton>
        <Dropdown.Popover placement="bottom start" className="w-56">
          <Dropdown.Menu aria-label="Issue actions">
            <Dropdown.Item id="copy-link" textValue="Copy issue URL" onAction={() => copy(window.location.href)}>
              Copy issue URL
            </Dropdown.Item>
            <Dropdown.Item id="copy-key" textValue="Copy issue ID" onAction={() => copy(issueKey)}>
              Copy issue ID
            </Dropdown.Item>
            {canDelete ? <Dropdown.Separator /> : null}
            {canDelete ? (
              <Dropdown.Item id="delete" textValue="Delete issue" onAction={remove}>
                <span className="text-error-primary">{pending ? 'Deleting…' : 'Delete issue…'}</span>
              </Dropdown.Item>
            ) : null}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown.Root>
      {error ? (
        <span role="alert" className="text-xs text-error-primary">
          {error}
        </span>
      ) : null}
    </span>
  );
}
