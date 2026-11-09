import { expect, test } from "bun:test"
import {
  GATEWAY_DICTATION_FINALIZE_TIMEOUT,
  GATEWAY_DICTATION_JOIN_TIMEOUT,
  createGatewayDictationState,
  transitionGatewayDictation,
  type GatewayDictationEffect,
  type GatewayDictationEvent,
  type GatewayDictationState,
} from "./gateway-dictation-machine"

function replay(events: GatewayDictationEvent[], start: GatewayDictationState = createGatewayDictationState()) {
  return events.reduce(
    (result: { state: GatewayDictationState; effects: GatewayDictationEffect[] }, event) => {
      const next = transitionGatewayDictation(result.state, event)

      return { state: next.state, effects: [...result.effects, ...next.effects] }
    },
    { state: start, effects: [] },
  )
}

const sliceAudio = "data:audio/webm;base64,AAAA"

test("join acquires the microphone with a join timer", () => {
  const next = transitionGatewayDictation(createGatewayDictationState(), { type: "join" })

  expect(next.state).toEqual({ status: "connecting", step: "mic" })
  expect(next.effects).toEqual([
    { type: "join.timer.start", ms: GATEWAY_DICTATION_JOIN_TIMEOUT },
    { type: "acquire.mic" },
  ])
})

test("join from a non-idle state is ignored", () => {
  const started = replay([{ type: "join" }]).state

  expect(transitionGatewayDictation(started, { type: "join" }).state).toBe(started)
})

test("the happy path reaches live once the microphone is ready", () => {
  const next = replay([{ type: "join" }, { type: "mic.ready" }])

  expect(next.state).toEqual({ status: "live", transcriptionFailed: false, emitted: false })
  expect(next.effects).toContainEqual({ type: "join.timer.clear" })
  expect(next.effects).toContainEqual({ type: "start.recorder" })
  expect(next.effects).toContainEqual({ type: "join.resolve" })
})

test("a denied microphone rejects the join and releases the microphone", () => {
  const next = replay([{ type: "join" }, { type: "mic.failed", reason: "microphone" }])

  expect(next.state).toEqual({ status: "closed" })
  expect(next.effects).toContainEqual({ type: "join.timer.clear" })
  expect(next.effects).toContainEqual({ type: "release.media" })
  expect(next.effects).toContainEqual({ type: "join.reject", reason: "microphone" })
})

test("a join timeout rejects the join as a connection failure", () => {
  const next = replay([{ type: "join" }, { type: "join.timeout" }])

  expect(next.state).toEqual({ status: "closed" })
  expect(next.effects).toContainEqual({ type: "release.media" })
  expect(next.effects).toContainEqual({ type: "join.reject", reason: "connection" })
})

test("closing while connecting rejects the join and releases the microphone", () => {
  const next = replay([{ type: "join" }, { type: "close" }])

  expect(next.state).toEqual({ status: "closed" })
  expect(next.effects).toContainEqual({ type: "release.media" })
  expect(next.effects).toContainEqual({ type: "join.reject", reason: "connection" })
})

test("a ready slice is sent for transcription while live", () => {
  const live = replay([{ type: "join" }, { type: "mic.ready" }]).state
  const next = transitionGatewayDictation(live, { type: "slice.ready", audio: sliceAudio })

  expect(next.state).toBe(live)
  expect(next.effects).toEqual([{ type: "transcribe.slice", audio: sliceAudio }])
})

test("a transcribed slice forwards its text as a completion", () => {
  const live = replay([{ type: "join" }, { type: "mic.ready" }]).state
  const next = transitionGatewayDictation(live, { type: "slice.transcribed", text: "olá" })

  expect(next.state).toEqual({ status: "live", transcriptionFailed: false, emitted: true })
  expect(next.effects).toEqual([
    {
      type: "forward.event",
      event: { type: "conversation.item.input_audio_transcription.completed", transcript: "olá" },
    },
  ])
})

test("later slices join the text already in the composer with one space", () => {
  const live = replay([
    { type: "join" },
    { type: "mic.ready" },
    { type: "slice.transcribed", text: "olá" },
  ]).state
  const next = transitionGatewayDictation(live, { type: "slice.transcribed", text: "mundo" })

  expect(next.state).toEqual({ status: "live", transcriptionFailed: false, emitted: true })
  expect(next.effects).toEqual([
    {
      type: "forward.event",
      event: { type: "conversation.item.input_audio_transcription.completed", transcript: " mundo" },
    },
  ])
})

test("a silent slice forwards nothing and does not count as emitted", () => {
  const live = replay([{ type: "join" }, { type: "mic.ready" }]).state
  const next = transitionGatewayDictation(live, { type: "slice.transcribed", text: "   " })

  expect(next.state).toBe(live)
  expect(next.effects).toEqual([])
})

test("a failed slice reports the failure once and stops further attempts", () => {
  const live = replay([{ type: "join" }, { type: "mic.ready" }]).state
  const next = transitionGatewayDictation(live, { type: "slice.failed", reason: "transcription" })

  expect(next.state).toEqual({ status: "live", transcriptionFailed: true, emitted: false })
  expect(next.effects).toEqual([{ type: "notify.failed", reason: "transcription" }])

  const discarded = transitionGatewayDictation(next.state, { type: "slice.ready", audio: sliceAudio })

  expect(discarded.state).toBe(next.state)
  expect(discarded.effects).toEqual([])

  const repeated = transitionGatewayDictation(next.state, { type: "slice.failed", reason: "transcription" })

  expect(repeated.state).toBe(next.state)
  expect(repeated.effects).toEqual([])
})

test("closing a live recording waits for the in-flight transcriptions", () => {
  const live = replay([{ type: "join" }, { type: "mic.ready" }]).state
  const next = transitionGatewayDictation(live, { type: "close" })

  expect(next.state).toEqual({ status: "finalizing", transcriptionFailed: false, emitted: false })
  expect(next.effects).toEqual([
    { type: "finalize.timer.start", ms: GATEWAY_DICTATION_FINALIZE_TIMEOUT },
    { type: "stop.recording" },
  ])
})

test("a final slice still forwards while finalizing", () => {
  const finalizing = replay([{ type: "join" }, { type: "mic.ready" }, { type: "close" }]).state
  const next = transitionGatewayDictation(finalizing, { type: "slice.transcribed", text: "olá" })

  expect(next.state).toEqual({ status: "finalizing", transcriptionFailed: false, emitted: true })
  expect(next.effects).toEqual([
    {
      type: "forward.event",
      event: { type: "conversation.item.input_audio_transcription.completed", transcript: "olá" },
    },
  ])
})

test("settled transcriptions close the recording", () => {
  const finalizing = replay([{ type: "join" }, { type: "mic.ready" }, { type: "close" }]).state
  const next = transitionGatewayDictation(finalizing, { type: "transcriptions.settled" })

  expect(next.state).toEqual({ status: "closed" })
  expect(next.effects).toEqual([
    { type: "finalize.timer.clear" },
    { type: "release.media" },
    { type: "close.resolve" },
  ])
})

test("a finalize timeout closes the recording even with transcriptions in flight", () => {
  const finalizing = replay([{ type: "join" }, { type: "mic.ready" }, { type: "close" }]).state
  const next = transitionGatewayDictation(finalizing, { type: "finalize.timeout" })

  expect(next.state).toEqual({ status: "closed" })
  expect(next.effects).toContainEqual({ type: "release.media" })
  expect(next.effects).toContainEqual({ type: "close.resolve" })
})

test("a slice failure while finalizing still reports once", () => {
  const finalizing = replay([{ type: "join" }, { type: "mic.ready" }, { type: "close" }]).state
  const next = transitionGatewayDictation(finalizing, { type: "slice.failed", reason: "unavailable" })

  expect(next.state).toEqual({ status: "finalizing", transcriptionFailed: true, emitted: false })
  expect(next.effects).toEqual([{ type: "notify.failed", reason: "unavailable" }])
})

test("closing an idle transport resolves at once", () => {
  const next = transitionGatewayDictation(createGatewayDictationState(), { type: "close" })

  expect(next.state).toEqual({ status: "closed" })
  expect(next.effects).toEqual([{ type: "close.resolve" }])
})
