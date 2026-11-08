import type { VoiceEvent } from "./protocol"

/** Bounds the whole handshake: models, ICE gathering, SDP exchange and the microphone. */
export const DICTATION_JOIN_TIMEOUT = 35_000

/** Bounds the `session.close` -> `session.closed` handshake before the peer is closed anyway. */
export const DICTATION_CLOSE_TIMEOUT = 1_000

export type DictationJoinFailure = "unavailable" | "microphone" | "connection"

type ConnectStep =
  /** Checking `voice.models` and setting the local offer. */
  | { type: "offer" }
  /** Waiting for ICE gathering to complete before the offer is sent. */
  | { type: "ice" }
  /** Posting the offer to `voice.session` and applying the answer. */
  | { type: "negotiating" }
  /** The answer is applied; acquiring the microphone. */
  | { type: "mic" }

export type DictationTransportState =
  | { status: "idle" }
  | { status: "connecting"; step: ConnectStep }
  | { status: "live" }
  /** `handshake` waits for `session.closed` after `session.close`; `releasing` closes the peer and audio. */
  | { status: "closing"; step: "handshake" | "releasing" }
  | { status: "closed" }

export type DictationTransportEvent =
  | { type: "join" }
  | { type: "offer.ready"; iceComplete: boolean }
  | { type: "ice.complete" }
  | { type: "answer.applied" }
  | { type: "mic.ready" }
  | { type: "step.failed"; step: "offer" | "negotiating" | "mic"; reason: DictationJoinFailure }
  | { type: "join.timeout" }
  | { type: "channel.closed" }
  | { type: "channel.message"; event: VoiceEvent }
  | { type: "peer.state"; state: RTCPeerConnectionState }
  | { type: "close" }
  | { type: "close.timeout" }
  | { type: "peer.released" }

export type DictationTransportEffect =
  | { type: "join.timer.start"; ms: number }
  | { type: "join.timer.clear" }
  | { type: "prepare.offer" }
  | { type: "negotiate" }
  | { type: "acquire.mic" }
  /** Stops the microphone and aborts the transport's requests. */
  | { type: "stop.media" }
  /** Sends `session.close`; dispatch `close.timeout` after `ms`. */
  | { type: "close.handshake.start"; ms: number }
  | { type: "close.timer.clear" }
  /** Closes the peer connection; dispatch `peer.released` once done. */
  | { type: "release.peer" }
  | { type: "forward.event"; event: VoiceEvent }
  | { type: "join.resolve" }
  | { type: "join.reject"; reason: DictationJoinFailure }
  | { type: "notify.dropped" }
  | { type: "close.resolve" }

export type DictationTransportTransition = {
  state: DictationTransportState
  effects: DictationTransportEffect[]
}

export function createDictationTransportState(): DictationTransportState {
  return { status: "idle" }
}

export function transitionDictationTransport(
  state: DictationTransportState,
  event: DictationTransportEvent,
): DictationTransportTransition {
  if (state.status === "idle") {
    if (event.type === "join")
      return {
        state: { status: "connecting", step: { type: "offer" } },
        effects: [{ type: "join.timer.start", ms: DICTATION_JOIN_TIMEOUT }, { type: "prepare.offer" }],
      }

    if (event.type === "close") return beginClose(state, false)

    return unchanged(state)
  }

  if (state.status === "connecting") return connecting(state, event)

  if (state.status === "live") return live(state, event)

  if (state.status === "closing") return closing(state, event)

  return unchanged(state)
}

/** The transport can still join; each transport joins once. */
export function canJoinDictationTransport(state: DictationTransportState) {
  return state.status === "idle"
}

/** A microphone granted now still belongs to this join. */
export function isAcquiringMicDictationTransport(state: DictationTransportState) {
  return state.status === "connecting" && state.step.type === "mic"
}

type Connecting = Extract<DictationTransportState, { status: "connecting" }>
type Live = Extract<DictationTransportState, { status: "live" }>

function connecting(state: Connecting, event: DictationTransportEvent): DictationTransportTransition {
  const reject = (reason: DictationJoinFailure): DictationTransportEffect => ({ type: "join.reject", reason })
  const step = state.step

  if (event.type === "offer.ready") {
    if (step.type !== "offer") return unchanged(state)

    if (!event.iceComplete) return { state: { ...state, step: { type: "ice" } }, effects: [] }

    return negotiate(state)
  }

  if (event.type === "ice.complete") {
    if (step.type !== "ice") return unchanged(state)

    return negotiate(state)
  }

  if (event.type === "answer.applied") {
    if (step.type !== "negotiating") return unchanged(state)

    return { state: { ...state, step: { type: "mic" } }, effects: [{ type: "acquire.mic" }] }
  }

  if (event.type === "mic.ready") {
    if (step.type !== "mic") return unchanged(state)

    return {
      state: { status: "live" },
      effects: [{ type: "join.timer.clear" }, { type: "join.resolve" }],
    }
  }

  if (event.type === "step.failed") {
    if (step.type !== event.step) return unchanged(state)

    return beginClose(state, true, reject(event.reason))
  }

  if (event.type === "join.timeout" || event.type === "close")
    return beginClose(state, true, reject("connection"))

  if (event.type === "channel.closed") return beginClose(state, false, reject("connection"))

  if (event.type === "channel.message") {
    const message = event.event

    if (message.type === "session.closed") return beginClose(state, false, reject("connection"))

    // Nothing has worked yet, so any error means this join failed.
    if (message.type === "error") return beginClose(state, true, reject("connection"))

    return forward(state, message)
  }

  if (event.type === "peer.state" && (event.state === "failed" || event.state === "closed"))
    return beginClose(state, false, reject("connection"))

  return unchanged(state)
}

function live(state: Live, event: DictationTransportEvent): DictationTransportTransition {
  const dropped: DictationTransportEffect = { type: "notify.dropped" }

  if (event.type === "channel.message") {
    const message = event.event

    if (message.type === "session.closed") return beginClose(state, false, dropped)

    // A transcription session has nothing to recover from: any error ends the recording.
    if (message.type === "error") return beginClose(state, true, dropped)

    return forward(state, message)
  }

  if (event.type === "channel.closed") return beginClose(state, false, dropped)

  if (event.type === "peer.state" && (event.state === "failed" || event.state === "closed"))
    return beginClose(state, false, dropped)

  if (event.type === "close") return beginClose(state, true)

  return unchanged(state)
}

function closing(
  state: Extract<DictationTransportState, { status: "closing" }>,
  event: DictationTransportEvent,
): DictationTransportTransition {
  if (state.step === "releasing") {
    if (event.type !== "peer.released") return unchanged(state)

    return { state: { status: "closed" }, effects: [{ type: "close.resolve" }] }
  }

  if (event.type === "close.timeout")
    return { state: { ...state, step: "releasing" }, effects: [{ type: "release.peer" }] }

  if (
    event.type === "channel.closed" ||
    (event.type === "channel.message" && event.event.type === "session.closed") ||
    (event.type === "peer.state" && (event.state === "failed" || event.state === "closed"))
  )
    return {
      state: { ...state, step: "releasing" },
      effects: [{ type: "close.timer.clear" }, { type: "release.peer" }],
    }

  return unchanged(state)
}

/**
 * Stops media and closes the session. It says goodbye with `session.close` only to a live session whose
 * channel is still up; `canHandshake` is false when the session, channel or peer already closed.
 */
function beginClose(
  state: Exclude<DictationTransportState, { status: "closing" | "closed" }>,
  canHandshake: boolean,
  exit?: DictationTransportEffect,
): DictationTransportTransition {
  const started = state.status === "live"
  const handshake = canHandshake && started

  const effects: DictationTransportEffect[] = [
    ...(state.status === "connecting" ? [{ type: "join.timer.clear" } as const] : []),
    { type: "stop.media" },
    handshake ? { type: "close.handshake.start", ms: DICTATION_CLOSE_TIMEOUT } : { type: "release.peer" },
    ...(exit ? [exit] : []),
  ]

  return { state: { status: "closing", step: handshake ? "handshake" : "releasing" }, effects }
}

function negotiate(state: Connecting): DictationTransportTransition {
  return {
    state: { ...state, step: { type: "negotiating" } },
    effects: [{ type: "negotiate" }],
  }
}

function forward(
  state: Connecting | Live,
  event: VoiceEvent,
): DictationTransportTransition {
  return { state, effects: [{ type: "forward.event", event }] }
}

function unchanged(state: DictationTransportState): DictationTransportTransition {
  return { state, effects: [] }
}
