import type { DictationJoinFailure } from "./dictation-machine"
import type { VoiceEvent } from "./protocol"

/**
 * Bounds the `recognition.start()` handshake: the browser's speech service must answer or fail
 * within this window, so the button never stays "connecting" forever. Same bound as the
 * Realtime join (DICTATION_JOIN_TIMEOUT): both handshakes depend on the network.
 */
export const BROWSER_DICTATION_JOIN_TIMEOUT = 35_000

/**
 * Live-error restarts: a transient failure (network, or an unknown service error) is worth
 * this many more runs before the recording ends with the real reason. A definitive failure
 * (microphone denied, service not allowed) never restarts — it ends the recording at once.
 */
export const BROWSER_DICTATION_LIVE_RETRIES = 3

type ConnectStep =
  /** Checking `window.SpeechRecognition` exists in this Chromium. */
  | { type: "check" }
  /** Waiting for the recognition service to start listening. */
  | { type: "starting" }

export type BrowserDictationState =
  | { status: "idle" }
  | { status: "connecting"; step: ConnectStep }
  /** `restarts` counts live-error restarts so far; a healthy run never resets it. */
  | { status: "live"; restarts: number }
  /** `releasing` stops the recognition and waits for its `end` event before resolving the close. */
  | { status: "closing"; step: "releasing" }
  | { status: "closed" }

export type BrowserDictationEvent =
  | { type: "join" }
  | { type: "check.ready" }
  | { type: "recognition.started" }
  | { type: "recognition.result"; event: VoiceEvent }
  /** A clean `end` while live: the service stopped by itself (a pause), so start it again. */
  | { type: "recognition.ended" }
  /**
   * An error while live, with the reason the service reported (mapped by the transport).
   * The reason decides whether the recording restarts or ends — it is never dropped.
   */
  | { type: "recognition.error"; reason: DictationJoinFailure }
  | { type: "step.failed"; step: "check" | "starting"; reason: DictationJoinFailure }
  | { type: "join.timeout" }
  | { type: "close" }
  | { type: "recognition.released" }

export type BrowserDictationEffect =
  | { type: "join.timer.start"; ms: number }
  | { type: "join.timer.clear" }
  | { type: "check.availability" }
  | { type: "start.recognition" }
  | { type: "restart.recognition" }
  | { type: "stop.recognition" }
  /** Detaches the recognition handlers and aborts any pending start; dispatch `recognition.released` once done. */
  | { type: "release.recognition" }
  | { type: "forward.event"; event: VoiceEvent }
  | { type: "join.resolve" }
  | { type: "join.reject"; reason: DictationJoinFailure }
  /** The recording ended with a failure; the button reports this reason, not a generic drop. */
  | { type: "notify.failed"; reason: DictationJoinFailure }
  | { type: "close.resolve" }

export type BrowserDictationTransition = {
  state: BrowserDictationState
  effects: BrowserDictationEffect[]
}

export function createBrowserDictationState(): BrowserDictationState {
  return { status: "idle" }
}

export function transitionBrowserDictation(
  state: BrowserDictationState,
  event: BrowserDictationEvent,
): BrowserDictationTransition {
  if (state.status === "idle") {
    if (event.type === "join")
      return {
        state: { status: "connecting", step: { type: "check" } },
        effects: [{ type: "join.timer.start", ms: BROWSER_DICTATION_JOIN_TIMEOUT }, { type: "check.availability" }],
      }

    if (event.type === "close") return beginClose(state)

    return unchanged(state)
  }

  if (state.status === "connecting") return connecting(state, event)

  if (state.status === "live") return live(state, event)

  if (state.status === "closing") return closing(state, event)

  return unchanged(state)
}

/** The transport can still join; each transport joins once. */
export function canJoinBrowserDictation(state: BrowserDictationState) {
  return state.status === "idle"
}

type Connecting = Extract<BrowserDictationState, { status: "connecting" }>
type Live = Extract<BrowserDictationState, { status: "live" }>

function connecting(state: Connecting, event: BrowserDictationEvent): BrowserDictationTransition {
  const reject = (reason: DictationJoinFailure): BrowserDictationEffect => ({ type: "join.reject", reason })
  const step = state.step

  if (event.type === "check.ready") {
    if (step.type !== "check") return unchanged(state)

    return { state: { ...state, step: { type: "starting" } }, effects: [{ type: "start.recognition" }] }
  }

  if (event.type === "recognition.started") {
    if (step.type !== "starting") return unchanged(state)

    return {
      state: { status: "live", restarts: 0 },
      effects: [{ type: "join.timer.clear" }, { type: "join.resolve" }],
    }
  }

  if (event.type === "step.failed") {
    if (step.type !== event.step) return unchanged(state)

    return beginClose(state, reject(event.reason))
  }

  if (event.type === "join.timeout" || event.type === "close")
    return beginClose(state, reject("connection"))

  return unchanged(state)
}

function live(state: Live, event: BrowserDictationEvent): BrowserDictationTransition {
  if (event.type === "recognition.result") return forward(state, event.event)

  if (event.type === "recognition.ended") return { state, effects: [{ type: "restart.recognition" }] }

  if (event.type === "recognition.error") {
    // A transient failure (network, or an unknown service error) is worth another run — the
    // service often recovers on the next one. A definitive failure (microphone denied, service
    // not allowed) ends the recording at once, with the real reason for the toast.
    if (
      (event.reason === "offline" || event.reason === "connection") &&
      state.restarts < BROWSER_DICTATION_LIVE_RETRIES
    )
      return {
        state: { ...state, restarts: state.restarts + 1 },
        effects: [{ type: "restart.recognition" }],
      }

    return beginClose(state, { type: "notify.failed", reason: event.reason })
  }

  if (event.type === "close") return beginClose(state)

  return unchanged(state)
}

function closing(
  state: Extract<BrowserDictationState, { status: "closing" }>,
  event: BrowserDictationEvent,
): BrowserDictationTransition {
  // The final transcript arrives as a result after `stop()`; it still belongs in the composer.
  if (event.type === "recognition.result") return forward(state, event.event)

  if (event.type === "recognition.ended")
    return { state, effects: [{ type: "release.recognition" }] }

  if (event.type === "recognition.released")
    return { state: { status: "closed" }, effects: [{ type: "close.resolve" }] }

  return unchanged(state)
}

/**
 * Stops a live recognition so its final transcript can still arrive, then releases it once the
 * service ends. A join that never resolved rejects through `exit`; a recognition that never
 * started is released right away. Idle has no join pending, so it releases with no reject.
 */
function beginClose(
  state: Exclude<BrowserDictationState, { status: "closing" | "closed" }>,
  exit?: BrowserDictationEffect,
): BrowserDictationTransition {
  if (state.status === "live")
    return {
      state: { status: "closing", step: "releasing" },
      effects: [{ type: "stop.recognition" }, ...(exit ? [exit] : [])],
    }

  return {
    state: { status: "closing", step: "releasing" },
    effects: [
      ...(state.status === "connecting" ? [{ type: "join.timer.clear" } as const] : []),
      { type: "release.recognition" },
      ...(exit ? [exit] : []),
    ],
  }
}

function forward(
  state: Connecting | Live | Extract<BrowserDictationState, { status: "closing" }>,
  event: VoiceEvent,
): BrowserDictationTransition {
  return { state, effects: [{ type: "forward.event", event }] }
}

function unchanged(state: BrowserDictationState): BrowserDictationTransition {
  return { state, effects: [] }
}
