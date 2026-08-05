'use client';

import type { ComponentProps, ReactNode } from 'react';
import NextLink from 'next/link';
import { Button, styles as buttonStyles } from '@/components/base/buttons/button';
import { cx } from '@/lib/utils/cx';

/**
 * An anchor wearing Untitled UI's button styles. Use for navigation, NEVER for a
 * mutation -- every mutation goes through a `<form action={serverAction}>`.
 *
 * Untitled UI's `Button` does render an anchor when given `href`, but through
 * react-aria's `Link`, which has no prefetching. Page headers and empty states
 * are dense with call-to-action links, so `next/link` is kept and only the
 * styles are borrowed. The `data-text` span mirrors what `Button` wraps its own
 * children in, so the padding and the `*:data-icon:` selectors behave
 * identically.
 *
 * This has to be its own `'use client'` module. `button.tsx` is a client module,
 * and `styles` is a plain object rather than a component: read from a Server
 * Component it arrives as a client *reference*, and `styles.colors[color].root`
 * is then `undefined` -- which fails at prerender, not at compile. Inside a
 * client module the import is the real object.
 */
type ButtonColor = NonNullable<ComponentProps<typeof Button>['color']>;
type ButtonSize = NonNullable<ComponentProps<typeof Button>['size']>;

type ButtonLinkProps = Omit<ComponentProps<typeof NextLink>, 'className' | 'color'> & {
  color?: ButtonColor;
  size?: ButtonSize;
  className?: string;
  children?: ReactNode;
};

export function ButtonLink({
  color = 'secondary',
  size = 'sm',
  className,
  children,
  ...rest
}: ButtonLinkProps) {
  const isLinkType = color.startsWith('link-');

  return (
    <NextLink
      {...rest}
      className={cx(
        buttonStyles.common.root,
        buttonStyles.sizes[size].root,
        buttonStyles.colors[color].root,
        isLinkType && buttonStyles.sizes[size].linkRoot,
        className,
      )}
    >
      <span data-text className={cx('transition-inherit-all', !isLinkType && 'px-0.5')}>
        {children}
      </span>
    </NextLink>
  );
}
