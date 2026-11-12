export * as BackgroundServiceRestart from "./background-service-restart"

// Plain bridge from main-process code to the background service machine:
// the desktop layer registers the restart runner at startup, and the
// client login asks for a restart through here after storing a new key.
// No-op while the layer has not registered (tests, CLI): a missed restart
// only leaves the reporter off until the next service start, never breaks
// the login.
let restarter: (() => void) | undefined

export function setBackgroundServiceRestarter(run: () => void): void {
  restarter = run
}

export function requestBackgroundServiceRestart(): void {
  restarter?.()
}
