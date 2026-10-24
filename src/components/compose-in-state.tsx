'use client';

import { IconPlus } from '@/components/icons';
import { requestCompose } from '@/lib/shell-events';

/** The `+` on a list group header: new issue, already in that state. */
export function ComposeInState({ stateId, stateName }: { stateId: string; stateName: string }) {
  return (
    <button
      type="button"
      onClick={(event) => {
        // The header is a <summary>; a click would also fold the group.
        event.preventDefault();
        requestCompose({ stateId });
      }}
      aria-label={`New issue in ${stateName}`}
      title={`New issue in ${stateName}`}
      className="grid size-6 place-items-center rounded-md text-tertiary transition-colors hover:bg-quaternary hover:text-primary"
    >
      <IconPlus className="size-3.5" />
    </button>
  );
}
