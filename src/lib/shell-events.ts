/**
 * Window events the app shell and the pages use to reach each other.
 *
 * The shell is one client component and every page is a separate tree under
 * it, so the few cross-cutting gestures -- open the drawer, open the command
 * menu, start a new issue -- travel as DOM events rather than through a context
 * every page would have to be wrapped in.
 */

export const OPEN_NAV_EVENT = 'flone:open-nav';
export const OPEN_COMMAND_MENU_EVENT = 'flone:open-command-menu';
/** Handled by a mounted `IssueComposer`; `preventDefault()` marks it handled. */
export const COMPOSE_EVENT = 'flone:compose';
/** Put on a project URL to open its composer on arrival. */
export const COMPOSE_HASH = '#new-issue';

/** Dispatches the compose event; true when a mounted composer took it. */
export function requestCompose(): boolean {
  const event = new Event(COMPOSE_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
