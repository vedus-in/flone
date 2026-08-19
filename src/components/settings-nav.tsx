'use client';

import { useEffect, useState } from 'react';

import { cx } from '@/lib/utils/cx';

export type SettingsNavItem = {
  /** The `id` of the `<section>` this points at. */
  id: string;
  label: string;
  tone?: 'danger';
};

/**
 * The settings side-nav, marking the section you are actually looking at.
 *
 * It was a column of plain links: six of them, down a page that scrolls six
 * screens, with nothing to say where you were. The links alone are the whole
 * feature without JavaScript -- they are real anchors and work before
 * hydration; the observer only adds the highlight.
 *
 * `rootMargin` clears the sticky app header at the top and discounts the bottom
 * 55% of the viewport, so "current" means the section under the top of the
 * page rather than whichever one happens to be tallest.
 */
export function SettingsNav({ items, label }: { items: SettingsNavItem[]; label: string }) {
  const [active, setActive] = useState(items[0]?.id ?? '');
  const keys = items.map((item) => item.id).join(',');

  useEffect(() => {
    const sections = keys
      .split(',')
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries.filter((entry) => entry.isIntersecting);
        if (visible.length === 0) return;
        const topmost = visible.reduce((a, b) =>
          a.boundingClientRect.top <= b.boundingClientRect.top ? a : b,
        );
        setActive(topmost.target.id);
      },
      { rootMargin: '-72px 0px -55% 0px' },
    );

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [keys]);

  return (
    <nav aria-label={label} className="lg:sticky lg:top-20">
      <ul className="flex flex-row flex-wrap gap-1 lg:flex-col">
        {items.map((item) => {
          const on = item.id === active;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                aria-current={on ? 'true' : undefined}
                className={cx(
                  'block rounded-lg px-3 py-1.5 text-sm font-medium no-underline transition-colors outline-focus-ring focus-visible:outline-2 focus-visible:outline-offset-2',
                  item.tone === 'danger'
                    ? 'text-error-primary hover:bg-error-primary'
                    : on
                      ? 'bg-secondary text-primary'
                      : 'text-tertiary hover:text-primary',
                  item.tone === 'danger' && on && 'bg-error-primary',
                )}
              >
                {item.label}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
