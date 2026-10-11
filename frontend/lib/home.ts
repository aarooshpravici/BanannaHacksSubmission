// The way home. The logo in the top bar (components/TopNav.tsx) asks for the
// first page; the Relight page, if one is on screen, shows it without being
// loaded again, so the depth model it has set up is kept.

/**
 * Fired on `window` when the logo is clicked. A page that can show its first
 * page in place does so and calls preventDefault() to say that it has.
 */
export const HOME_EVENT = "relight:home";

/** Ask the page on screen for its first page. False if nothing answered (the "not found" page): the logo is then followed as the ordinary link it is. */
export function goHome(): boolean {
  const event = new Event(HOME_EVENT, { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}
