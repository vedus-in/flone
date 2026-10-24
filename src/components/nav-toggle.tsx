'use client';

import { IconMenu } from '@/components/icons';
import { OPEN_NAV_EVENT } from '@/lib/shell-events';

/** The hamburger in a `PageBar` on narrow screens; opens the shell's drawer. */
export function NavToggle() {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_NAV_EVENT))}
      aria-label="Open navigation"
      className="-ms-1 grid size-7 shrink-0 place-items-center rounded-md text-tertiary transition-colors hover:bg-secondary hover:text-primary lg:hidden"
    >
      <IconMenu />
    </button>
  );
}
