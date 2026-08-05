'use client';

import type { PropsWithChildren } from 'react';
import { useRouter } from 'next/navigation';
import { RouterProvider } from 'react-aria-components';

/**
 * Teaches React Aria how to navigate.
 *
 * Untitled UI's `Button`/`Link` render react-aria's `Link` when given an `href`.
 * Without this provider every one of them would do a full document load; with
 * it they route through Next's client router instead.
 *
 * This is a Client Component, but only the provider itself -- `children` are
 * still streamed as Server Components, so wrapping the whole app costs nothing.
 *
 * `next/link` is still the right tool where prefetching matters (the sidebar,
 * `ButtonLink`); this only covers the components that come from the library.
 */
declare module 'react-aria-components' {
  interface RouterConfig {
    routerOptions: NonNullable<Parameters<ReturnType<typeof useRouter>['push']>[1]>;
  }
}

export function RouteProvider({ children }: PropsWithChildren) {
  const router = useRouter();

  return <RouterProvider navigate={router.push}>{children}</RouterProvider>;
}
