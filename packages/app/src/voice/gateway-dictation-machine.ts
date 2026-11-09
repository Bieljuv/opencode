import type { DictationJoinFailure } from "./dictation-machine"
import type { VoiceEvent } from "./protocol"

/**
 * One slice of speech, ~4 s: long enough to transcribe well, short enough to feel live.
 * Ported from the Forge (2.96.4, Fase 4): the front records in slices, the MediaRecorder
 * restarts per slice so each slice is a valid webm by itself, and each slice becomes one
 * transcription call — the text reaches the composer in real time and the audio is discarded.
 */
export const GATEWAY_DICTATION_SLICE_MS = 4000

/** Bounds the microphone acquisition: a permission prompt can take a while. */
export const GATEWAY_DICTATION_JOIN_TIMEOUT = 35_000

/** Bounds the wait for in-flight slice transcriptions after the user stops recording. */
export const GATEWAY_DICTATION_FINALIZE_TIMEOUT = 15_000

export type GatewayDictationState =
  | { status: "idle" }
  | { status: "connecting"; step: "mic" }
  /**
   * `transcriptionFailed` is set once a slice fails: the recording keeps going (the Forge
   * kept it going) but no more slices are sent — the gateway is down or the key is missing,
   * and retrying every 4 s would only burn the daily limit. `emitted` tracks whether any
   * slice text already reached the composer, so later slices join it with one space.
   */
  | { status: "live"; transcriptionFailed: boolean; emitted: boolean }
  | { status: "finalizing"; transcriptionFailed: boolean; emitted: boolean }
  | { status: "closed" }

export type GatewayDictationEvent =
  | { type: "join" }
  | { type: "mic.ready" }
  | { type: "mic.failed"; reason: "microphone" | "unavailable" }
  /** One recorded slice, as a data URL; the machine decides whether it is transcribed. */
  | { type: "slice.ready"; audio: string }
  /** A slice came back with text (empty = no speech in the slice). */
  | { type: "slice.transcribed"; text: string }
  /** A slice could not be transcribed; the reason decides the toast. */
  | { type: "slice.failed"; reason: "unavailable" | "transcription" }
  /** The transcription chain drained while finalizing. */
  | { type: "transcriptions.settled" }
  | { type: "finalize.timeout" }
  | { type: "join.timeout" }
  | { type: "close" }

export type GatewayDictationEffect =
  | { type: "join.timer.start"; ms: number }
  | { type: "join.timer.clear" }
  | { type: "acquire.mic" }
  /** Starts the slice recorder and the 4 s slice timer. */
  | { type: "start.recorder" }
  /** Stops the slice timer and the current recorder; its `onstop` yields the final slice. */
  | { type: "stop.recording" }
  | { type: "transcribe.slice"; audio: string }
  | { type: "forward.event"; event: VoiceEvent }
  | { type: "join.resolve" }
  | { type: "join.reject"; reason: DictationJoinFailure }
  /** The recording failed; the button reports this reason, not a generic drop. */
  | { type: "notify.failed"; reason: DictationJoinFailure }
  | { type: "finalize.timer.start"; ms: number }
  | { type: "finalize.timer.clear" }
  /** Stops the microphone tracks and clears the timers; dispatch nothing after this. */
  | { type: "release.media" }
  | { type: "close.resolve" }

export type GatewayDictationTransition = {
  state: GatewayDictationState
  effects: GatewayDictationEffect[]
}

export function createGatewayDictationState(): GatewayDictationState {
  return { status: "idle" }
}

export function transitionGatewayDictation(
  state: GatewayDictationState,
  event: GatewayDictationEvent,
): GatewayDictationTransition {
  if (state.status === "idle") {
    if (event.type === "join")
      return {
        state: { status: "connecting", step: "mic" },
        effects: [{ type: "join.timer.start", ms: GATEWAY_DICTATION_JOIN_TIMEOUT }, { type: "acquire.mic" }],
      }

    if (event.type === "close") return { state: { status: "closed" }, effects: [{ type: "close.resolve" }] }

    return unchanged(state)
  }

  if (state.status === "connecting") return connecting(state, event)

  if (state.status === "live") return live(state, event)

  if (state.status === "finalizing") return finalizing(state, event)

  return unchanged(state)
}

/** The transport can still join; each transport joins once. */
export function canJoinGatewayDictation(state: GatewayDictationState) {
  return state.status === "idle"
}

type Connecting = Extract<GatewayDictationState, { status: "connecting" }>
type Live = Extract<GatewayDictationState, { status: "live" }>
type Finalizing = Extract<GatewayDictationState, { status: "finalizing" }>

function connecting(state: Connecting, event: GatewayDictationEvent): GatewayDictationTransition {
  if (event.type === "mic.ready")
    return {
      state: { status: "live", transcriptionFailed: false, emitted: false },
      effects: [{ type: "join.timer.clear" }, { type: "start.recorder" }, { type: "join.resolve" }],
    }

  if (event.type === "mic.failed")
    return {
      state: { status: "closed" },
      effects: [{ type: "join.timer.clear" }, { type: "release.media" }, { type: "join.reject", reason: event.reason }],
    }

  if (event.type === "join.timeout" || event.type === "close")
    return {
      state: { status: "closed" },
      effects: [{ type: "join.timer.clear" }, { type: "release.media" }, { type: "join.reject", reason: "connection" }],
    }

  return unchanged(state)
}

function live(state: Live, event: GatewayDictationEvent): GatewayDictationTransition {
  if (event.type === "slice.ready") {
    // A failed transcription stops further attempts for this recording; the slice is discarded.
    if (state.transcriptionFailed) return unchanged(state)

    return { state, effects: [{ type: "transcribe.slice", audio: event.audio }] }
  }

  if (event.type === "slice.transcribed") return transcribed(state, event.text)

  if (event.type === "slice.failed") {
    // The error is reported once; later slices are discarded, not retried.
    if (state.transcriptionFailed) return unchanged(state)

    return {
      state: { ...state, transcriptionFailed: true },
      effects: [{ type: "notify.failed", reason: event.reason }],
    }
  }

  if (event.type === "close")
    return {
      state: { status: "finalizing", transcriptionFailed: state.transcriptionFailed, emitted: state.emitted },
      effects: [{ type: "finalize.timer.start", ms: GATEWAY_DICTATION_FINALIZE_TIMEOUT }, { type: "stop.recording" }],
    }

  return unchanged(state)
}

function finalizing(state: Finalizing, event: GatewayDictationEvent): GatewayDictationTransition {
  if (event.type === "slice.ready") {
    if (state.transcriptionFailed) return unchanged(state)

    return { state, effects: [{ type: "transcribe.slice", audio: event.audio }] }
  }

  if (event.type === "slice.transcribed") return transcribed(state, event.text)

  if (event.type === "slice.failed") {
    if (state.transcriptionFailed) return unchanged(state)

    return {
      state: { ...state, transcriptionFailed: true },
      effects: [{ type: "notify.failed", reason: event.reason }],
    }
  }

  if (event.type === "transcriptions.settled" || event.type === "finalize.timeout")
    return {
      state: { status: "closed" },
      effects: [{ type: "finalize.timer.clear" }, { type: "release.media" }, { type: "close.resolve" }],
    }

  return unchanged(state)
}

/**
 * A slice with text joins the text already in the composer with one space — the Forge's
 * `${prev} ${t}` rule. An empty slice is silence: nothing is forwarded and `emitted` stays
 * put, so the next slice with speech does not start with a stray space.
 */
function transcribed(
  state: Live | Finalizing,
  text: string,
): GatewayDictationTransition {
  const trimmed = text.trim()

  if (!trimmed) return unchanged(state)

  const transcript = state.emitted ? ` ${trimmed}` : trimmed

  return {
    state: { ...state, emitted: true },
    effects: [
      {
        type: "forward.event",
        event: { type: "conversation.item.input_audio_transcription.completed", transcript },
      },
    ],
  }
}

function unchanged(state: GatewayDictationState): GatewayDictationTransition {
  return { state, effects: [] }
}
