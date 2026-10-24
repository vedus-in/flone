import type { SVGProps } from 'react';

import { cx } from '@/lib/utils/cx';

/**
 * The app's own 16px line icons.
 *
 * Drawn on a 16-unit grid with a 1.5 stroke and round caps, so they sit at the
 * same optical weight as 13px Inter. Server-safe -- plain SVG, no hooks -- so a
 * Server Component can render them, and a client module can import them too.
 *
 * Every icon is decorative by default (`aria-hidden`); the control around it
 * carries the accessible name.
 */

type IconProps = Omit<SVGProps<SVGSVGElement>, 'children'>;

function make(paths: string[], { filled = false }: { filled?: boolean } = {}) {
  function IconComponent({ className, ...rest }: IconProps) {
    return (
      <svg
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden="true"
        {...rest}
        className={cx('size-4 shrink-0', className)}
      >
        {paths.map((d) =>
          filled ? (
            <path key={d} d={d} fill="currentColor" />
          ) : (
            <path
              key={d}
              d={d}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ),
        )}
      </svg>
    );
  }
  return IconComponent;
}

export const IconSearch = make(['M7.25 12.5a5.25 5.25 0 1 0 0-10.5 5.25 5.25 0 0 0 0 10.5Z', 'm11 11 3 3']);
export const IconCompose = make([
  'M13.5 8.5V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h3.5',
  'M11.6 2.4a1.4 1.4 0 0 1 2 2L8.5 9.5 6 10l.5-2.5z',
]);
export const IconPlus = make(['M8 3.25v9.5', 'M3.25 8h9.5']);
export const IconChevronRight = make(['m6 3.75 4.25 4.25L6 12.25']);
export const IconChevronDown = make(['m3.75 6 4.25 4.25L12.25 6']);
export const IconChevronUpDown = make(['m5 6 3-3 3 3', 'm5 10 3 3 3-3']);
export const IconArrowUp = make(['M8 13V3', 'm4 7 4-4 4 4']);
export const IconArrowDown = make(['M8 3v10', 'm4 9 4 4 4-4']);
/** The small filled triangle beside a collapsible sidebar heading. */
export const IconCaret = make(['M4.5 6.25h7L8 10.25z'], { filled: true });
export const IconMore = make(
  [
    'M3.5 9.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z',
    'M8 9.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z',
    'M12.5 9.25a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Z',
  ],
  { filled: true },
);
export const IconClose = make(['m4 4 8 8', 'm12 4-8 8']);
export const IconCheck = make(['m3.5 8.5 3 3 6-7']);
export const IconMenu = make(['M2.5 4.5h11', 'M2.5 8h11', 'M2.5 11.5h11']);

export const IconHome = make(['M2.75 6.75 8 2.5l5.25 4.25v6.75h-3.5v-4h-3.5v4h-3.5z']);
export const IconIssues = make([
  'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z',
  'M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z',
]);
export const IconCycle = make([
  'M13.5 8A5.5 5.5 0 1 1 8 2.5',
  'M13.5 8A5.5 5.5 0 0 0 8 2.5',
  'M8 5v3l2 1.5',
]);
export const IconBoard = make(['M3 2.75h3.25v10.5H3z', 'M9.75 2.75H13v6.5H9.75z']);
export const IconViews = make(['M8 2.25 14 5.5 8 8.75 2 5.5z', 'm2 8.25 6 3.25 6-3.25', 'm2 11 6 3.25L14 11']);
export const IconDocument = make(['M4 1.75h5.25l3 3v9.5H4z', 'M9 1.75v3.25h3.25', 'M6.25 8.25h3.5', 'M6.25 11h3.5']);
export const IconRepeat = make([
  'M11.5 1.75 13.75 4 11.5 6.25',
  'M2.25 7.25V6.5A2.5 2.5 0 0 1 4.75 4h9',
  'M4.5 14.25 2.25 12 4.5 9.75',
  'M13.75 8.75v.75A2.5 2.5 0 0 1 11.25 12h-9',
]);
export const IconTarget = make([
  'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z',
  'M8 10.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z',
]);
export const IconBell = make([
  'M4 6.75a4 4 0 1 1 8 0c0 3 1.25 4.25 1.25 4.25H2.75S4 9.75 4 6.75Z',
  'M6.5 13.25a1.6 1.6 0 0 0 3 0',
]);
export const IconWorkspaces = make([
  'M2.5 2.5h4.25v4.25H2.5z',
  'M9.25 2.5h4.25v4.25H9.25z',
  'M2.5 9.25h4.25v4.25H2.5z',
  'M9.25 9.25h4.25v4.25H9.25z',
]);
export const IconSettings = make([
  'M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z',
  'M12.9 9.6a1.1 1.1 0 0 0 .22 1.2l.04.04a1.33 1.33 0 1 1-1.89 1.89l-.04-.04a1.1 1.1 0 0 0-1.2-.22 1.1 1.1 0 0 0-.67 1.01v.12a1.33 1.33 0 1 1-2.67 0v-.06a1.1 1.1 0 0 0-.72-1.01 1.1 1.1 0 0 0-1.2.22l-.04.04a1.33 1.33 0 1 1-1.89-1.89l.04-.04a1.1 1.1 0 0 0 .22-1.2 1.1 1.1 0 0 0-1.01-.67h-.12a1.33 1.33 0 1 1 0-2.67h.06a1.1 1.1 0 0 0 1.01-.72 1.1 1.1 0 0 0-.22-1.2l-.04-.04a1.33 1.33 0 1 1 1.89-1.89l.04.04a1.1 1.1 0 0 0 1.2.22h.05a1.1 1.1 0 0 0 .67-1.01v-.12a1.33 1.33 0 1 1 2.67 0v.06a1.1 1.1 0 0 0 .67 1.01 1.1 1.1 0 0 0 1.2-.22l.04-.04a1.33 1.33 0 1 1 1.89 1.89l-.04.04a1.1 1.1 0 0 0-.22 1.2v.05a1.1 1.1 0 0 0 1.01.67h.12a1.33 1.33 0 1 1 0 2.67h-.06a1.1 1.1 0 0 0-1.01.67Z',
]);
export const IconUsers = make([
  'M6 7.5a2.25 2.25 0 1 0 0-4.5 2.25 2.25 0 0 0 0 4.5Z',
  'M1.75 13.5a4.25 4.25 0 0 1 8.5 0',
  'M11 3.2a2.25 2.25 0 0 1 0 4.4',
  'M12.2 9.6a4.25 4.25 0 0 1 2.05 3.9',
]);
export const IconUser = make(['M8 7.5a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z', 'M2.75 14a5.25 5.25 0 0 1 10.5 0']);
export const IconKey = make([
  'M10.25 9.5a3.75 3.75 0 1 0-3.6-2.7L2.25 11.2v2.55H4.8v-1.5h1.5v-1.5h1.5l.85-.85a3.74 3.74 0 0 0 1.6.6Z',
  'M11 5.5h.01',
]);
export const IconShield = make(['M8 1.75 13.25 3.5v4.25c0 3.25-2.25 5.5-5.25 6.5-3-1-5.25-3.25-5.25-6.5V3.5z']);
export const IconSignOut = make(['M6.25 13.75h-2.5a1.5 1.5 0 0 1-1.5-1.5v-8.5a1.5 1.5 0 0 1 1.5-1.5h2.5', 'm10.5 11 3-3-3-3', 'M13.5 8H6']);
export const IconSun = make([
  'M8 10.75a2.75 2.75 0 1 0 0-5.5 2.75 2.75 0 0 0 0 5.5Z',
  'M8 1.25v1.5',
  'M8 13.25v1.5',
  'm3.23 3.23 1.06 1.06',
  'm11.71 11.71 1.06 1.06',
  'M1.25 8h1.5',
  'M13.25 8h1.5',
  'm3.23 12.77 1.06-1.06',
  'm11.71 4.29 1.06-1.06',
]);
export const IconMoon = make(['M13.5 9.6A5.75 5.75 0 1 1 6.4 2.5a4.5 4.5 0 0 0 7.1 7.1Z']);
export const IconMonitor = make(['M2 3h12v8H2z', 'M5.5 14h5', 'M8 11v3']);
export const IconFilter = make(['M2.5 4h11', 'M4.75 8h6.5', 'M6.75 12h2.5']);
export const IconDisplay = make([
  'M2.5 4.5h3',
  'M8.5 4.5h5',
  'M2.5 11.5h6',
  'M11.5 11.5h2',
  'M7 6a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
  'M10 13a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z',
]);
export const IconPanelRight = make(['M2.5 3h11v10h-11z', 'M10 3v10']);
export const IconLink = make([
  'M6.75 9.25a2.8 2.8 0 0 0 4 0l2-2a2.83 2.83 0 0 0-4-4l-.75.75',
  'M9.25 6.75a2.8 2.8 0 0 0-4 0l-2 2a2.83 2.83 0 0 0 4 4l.75-.75',
]);
export const IconCopy = make(['M5.5 5.5h8v8h-8z', 'M10.5 5.5v-3h-8v8h3']);
export const IconTrash = make(['M2.75 4.25h10.5', 'M6.25 4.25V2.75h3.5v1.5', 'M4 4.25l.6 9h6.8l.6-9']);
export const IconKeyboard = make(['M1.75 4h12.5v8H1.75z', 'M4.5 6.75h.01', 'M7 6.75h.01', 'M9.5 6.75h.01', 'M12 6.75h.01', 'M5 9.5h6']);
export const IconFolder = make([
  'M2.25 5.25A1.5 1.5 0 0 1 3.75 3.75h2.19c.4 0 .78.16 1.06.44l.81.81h4.44a1.5 1.5 0 0 1 1.5 1.5v5.25a1.5 1.5 0 0 1-1.5 1.5h-8.5a1.5 1.5 0 0 1-1.5-1.5z',
]);
export const IconComment = make(['M13.75 9.5a2 2 0 0 1-2 2H5.5l-3.25 2.75V4.25a2 2 0 0 1 2-2h7.5a2 2 0 0 1 2 2z']);
export const IconAttach = make([
  'm13.25 7.6-5.4 5.4a3.18 3.18 0 0 1-4.5-4.5l5.4-5.4a2.12 2.12 0 0 1 3 3L6.33 11.5a1.06 1.06 0 0 1-1.5-1.5l4.95-4.95',
]);
export const IconCalendar = make(['M2.5 3.5h11v10h-11z', 'M2.5 6.5h11', 'M5.5 2v3', 'M10.5 2v3']);
