/**
 * Google Analytics 4 Key Events Tracking
 *
 * Provides helper functions to fire GA4 custom events for key user actions.
 * Each function maps to an event that should be marked as a Key Event in GA4.
 */

declare function gtag(command: 'event', eventName: string, eventParams?: Record<string, unknown>): void;

function fireEvent(eventName: string, params: Record<string, string | number | boolean>): void {
  if (typeof gtag === 'function') {
    gtag('event', eventName, params);
  }
}

/** Fired when the user starts a simulation (clicks Run). */
export function trackRunSimulation(): void {
  fireEvent('run_simulation', { event_category: 'engagement' });
}

/** Fired when a user loads a sample project from the examples gallery. */
export function trackOpenExample(exampleTitle?: string): void {
  fireEvent('open_example', {
    event_category: 'engagement',
    ...(exampleTitle ? { event_label: exampleTitle } : {}),
  });
}

/** Fired when a user successfully creates a new project. */
export function trackCreateProject(): void {
  fireEvent('create_project', { event_category: 'engagement' });
}

/** Fired when code compilation starts. */
export function trackCompileCode(): void {
  fireEvent('compile_code', { event_category: 'development' });
}

/** Fired when a user clicks any GitHub repository link. */
export function trackVisitGitHub(): void {
  fireEvent('visit_github', { event_category: 'external_link' });
}
