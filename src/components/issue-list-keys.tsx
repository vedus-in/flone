'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Keyboard movement through an issue list: `J` / `↓` to the next row, `K` / `↑`
 * to the previous one, `Enter` to open it (the row's link handles that itself).
 *
 * Rows are found by `[data-row-link]` -- the title link every `IssueRowView`
 * carries -- so this wraps any list without knowing its shape. Focus moves to
 * the link, which is what lights the row up. Keys typed into a field, or while
 * a menu or dialog is open, are left alone.
 */
export function IssueListKeys({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      }
      if (document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return;

      const step =
        event.key === 'j' || event.key === 'ArrowDown' ? 1 : event.key === 'k' || event.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;

      const root = ref.current;
      if (!root) return;
      // Rows inside a collapsed group are not in the layout; skip them.
      const rows = Array.from(root.querySelectorAll<HTMLAnchorElement>('[data-row-link]')).filter(
        (row) => row.offsetParent !== null,
      );
      if (rows.length === 0) return;

      const current = rows.indexOf(document.activeElement as HTMLAnchorElement);
      // Arrow keys elsewhere on the page keep scrolling it until a row has focus.
      if (current === -1 && event.key.startsWith('Arrow')) return;

      event.preventDefault();
      const next = current === -1 ? (step === 1 ? 0 : rows.length - 1) : Math.min(Math.max(current + step, 0), rows.length - 1);
      rows[next].focus({ preventScroll: true });
      rows[next].scrollIntoView({ block: 'nearest' });
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  );
}
