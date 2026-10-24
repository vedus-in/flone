import { Fragment, type ReactNode } from 'react';
import NextLink from 'next/link';

import { IconChevronRight } from '@/components/icons';
import { NavToggle } from '@/components/nav-toggle';
import { cx } from '@/lib/utils/cx';

/**
 * Page furniture for the inset panel, Linear-style.
 *
 * Every page under the authenticated shell opens with a `PageBar`: one 44px
 * row carrying the breadcrumb on the left and the page's actions on the right.
 * There is no separate page title -- the last crumb IS the title, which is why
 * it is the one crumb rendered as the page's `<h1>`. Pages whose body carries
 * its own `<h1>` (an issue, a document) pass `crumbHeading={false}`.
 *
 * List-like pages add a `PageToolbar` underneath for view tabs and display
 * controls; reading pages (settings, documents) wrap their content in
 * `PageBody` for the centred column.
 *
 * Server-safe: no hooks. The only client piece is the mobile `NavToggle`.
 */

export type Crumb = {
  label: ReactNode;
  href?: string;
  icon?: ReactNode;
};

export function PageBar({
  crumbs,
  actions,
  children,
  crumbHeading = true,
  className,
}: {
  crumbs: Crumb[];
  /** Render the last crumb as the page's `<h1>`. */
  crumbHeading?: boolean;
  /** Right-hand cluster: a "New issue" button, a counter, icon buttons. */
  actions?: ReactNode;
  /** Rendered right after the breadcrumb: a star, a "..." menu, a badge. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cx(
        'sticky top-0 z-20 flex h-11 shrink-0 items-center gap-2 border-b border-tertiary bg-primary px-3 lg:px-4.5',
        className,
      )}
    >
      <NavToggle />
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          {crumbs.map((crumb, index) => {
            const last = index === crumbs.length - 1;
            const body = (
              <>
                {crumb.icon ? <span className="flex shrink-0">{crumb.icon}</span> : null}
                <span className="truncate">{crumb.label}</span>
              </>
            );
            return (
              <Fragment key={index}>
                {index > 0 ? (
                  <li aria-hidden="true" className="flex shrink-0 text-quaternary">
                    <IconChevronRight className="size-3" />
                  </li>
                ) : null}
                <li className={cx('flex min-w-0 items-center', !last && 'shrink-[2]')}>
                  {last && crumbHeading ? (
                    <h1
                      aria-current="page"
                      className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 font-medium text-primary"
                    >
                      {body}
                    </h1>
                  ) : last ? (
                    <span
                      aria-current="page"
                      className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 font-medium text-primary"
                    >
                      {body}
                    </span>
                  ) : crumb.href ? (
                    <NextLink
                      href={crumb.href}
                      className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 font-medium text-secondary no-underline transition-colors outline-focus-ring hover:bg-secondary hover:text-primary focus-visible:outline-2"
                    >
                      {body}
                    </NextLink>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1.5 px-1 py-0.5 font-medium text-secondary">
                      {body}
                    </span>
                  )}
                </li>
              </Fragment>
            );
          })}
        </ol>
      </nav>
      {children ? <div className="flex shrink-0 items-center gap-1">{children}</div> : null}
      {actions ? (
        <div className="ms-auto flex shrink-0 items-center gap-1.5">{actions}</div>
      ) : null}
    </header>
  );
}

/** The second row under a `PageBar`: view tabs left, display controls right. */
export function PageToolbar({
  children,
  actions,
  className,
}: {
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('flex h-11 shrink-0 items-center gap-1.5 px-2 lg:px-2.5', className)}>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto scrollbar-hide">
        {children}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

/** One view tab -- a real link, so every view is a URL you can send someone. */
export function ViewTab({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <NextLink
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex h-6 shrink-0 items-center gap-1.5 rounded-[7px] border px-2.5 text-xs font-medium whitespace-nowrap no-underline transition-colors outline-focus-ring focus-visible:outline-2',
        active
          ? 'border-secondary_alt bg-quaternary text-primary'
          : 'border-transparent bg-tertiary text-tertiary hover:text-primary',
      )}
    >
      {children}
    </NextLink>
  );
}

/** A 28px square icon control for toolbars. Pass `href` for a link. */
export function ToolbarIconLink({
  href,
  label,
  children,
  active = false,
}: {
  href: string;
  label: string;
  children: ReactNode;
  active?: boolean;
}) {
  return (
    <NextLink
      href={href}
      aria-label={label}
      title={label}
      className={cx(
        'grid size-7 place-items-center rounded-md no-underline transition-colors outline-focus-ring hover:bg-secondary hover:text-primary focus-visible:outline-2',
        active ? 'bg-secondary text-primary' : 'text-tertiary',
      )}
    >
      {children}
    </NextLink>
  );
}

/** A quiet text action for the `PageBar` -- "New issue" in Linear's header. */
export const PAGE_BAR_ACTION =
  'flex h-7 items-center gap-1.5 rounded-md px-2 text-sm font-medium text-secondary no-underline transition-colors outline-focus-ring hover:bg-secondary hover:text-primary focus-visible:outline-2';

/**
 * The centred reading column for settings and other form pages.
 * `wide` for pages that hold a table; `full` for a board or a list.
 */
export function PageBody({
  children,
  width = 'default',
  className,
}: {
  children: ReactNode;
  width?: 'narrow' | 'default' | 'wide' | 'full';
  className?: string;
}) {
  return (
    <div
      className={cx(
        'w-full',
        width === 'full'
          ? 'px-0'
          : cx(
              'mx-auto px-4 py-8 sm:px-6 lg:py-12',
              width === 'narrow' && 'max-w-xl',
              width === 'default' && 'max-w-3xl',
              width === 'wide' && 'max-w-5xl',
            ),
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A section title inside a `PageBody`, the large heading on a settings page. */
export function BodyTitle({ title, description }: { title: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-8 flex flex-col gap-1.5">
      <h2 className="text-display-xs font-semibold text-primary">{title}</h2>
      {description ? <p className="text-sm text-pretty text-tertiary">{description}</p> : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Project glyph                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Fixed hues for project glyphs, picked by the key so a project keeps its colour
 * everywhere without storing one.
 */
const GLYPH_COLORS = ['#5e6ad2', '#26b5ce', '#4cb782', '#f2c94c', '#f2994a', '#eb5757', '#bb87fc', '#f7b5d9'];

function glyphColor(seed: string): string {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return GLYPH_COLORS[hash % GLYPH_COLORS.length];
}

/** The small coloured tile a project wears in the sidebar and the breadcrumb. */
export function ProjectGlyph({
  projectKey,
  className,
}: {
  projectKey: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      style={{ backgroundColor: glyphColor(projectKey) }}
      className={cx(
        'grid size-3.5 shrink-0 place-items-center rounded-[4px] text-[0.5625rem] leading-none font-semibold text-black/75',
        className,
      )}
    >
      {Array.from(projectKey)[0] ?? ''}
    </span>
  );
}
