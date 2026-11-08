import { expect, test } from "bun:test"
import {
  BROWSER_DICTATION_JOIN_TIMEOUT,
  createBrowserDictationState,
  transitionBrowserDictation,
  type BrowserDictationEffect,
  type BrowserDictationEvent,
  type BrowserDictationState,
} from "./browser-dictation-machine"

function replay(events: BrowserDictationEvent[], start: BrowserDictationState = createBrowserDictationState()) {
  return events.reduce(
    (result: { state: BrowserDictationState; effects: BrowserDictationEffect[] }, event) => {
      const next = transitionBrowserDictation(result.state, event)

      return { state: next.state, effects: [...result.effects, ...next.effects] }
    },
    { state: start, effects: [] },
  )
}

const transcriptDelta = { type: "conversation.item.input_audio_transcription.delta", delta: "olá " } as const

test("join starts the availability check with a join timer", () => {
  const next = transitionBrowserDictation(createBrowserDictationState(), { type: "join" })

  expect(next.state).toEqual({ status: "connecting", step: { type: "check" } })
  expect(next.effects).toEqual([
    { type: "join.timer.start", ms: BROWSER_DICTATION_JOIN_TIMEOUT },
    { type: "check.availability" },
  ])
})

test("join from a non-idle state is ignored", () => {
  const started = replay([{ type: "join" }]).state

  expect(transitionBrowserDictation(started, { type: "join" }).state).toBe(started)
})

test("an available recognition starts listening", () => {
  const next = replay([{ type: "join" }, { type: "check.ready" }])

  expect(next.state).toEqual({ status: "connecting", step: { type: "starting" } })
  expect(next.effects).toContainEqual({ type: "start.recognition" })
})

test("the happy path reaches live once the recognition starts", () => {
  const next = replay([{ type: "join" }, { type: "check.ready" }, { type: "recognition.started" }])

  expect(next.state).toEqual({ status: "live" })
  expect(next.effects).toContainEqual({ type: "join.timer.clear" })
  expect(next.effects).toContainEqual({ type: "join.resolve" })
})

test("recognition starting before the check is ignored", () => {
  const next = replay([{ type: "join" }, { type: "recognition.started" }])

  expect(next.state).toEqual({ status: "connecting", step: { type: "check" } })
  expect(next.effects).not.toContainEqual({ type: "join.resolve" })
})

test("a failed step rejects the join and releases the recognition", () => {
  const next = replay([{ type: "join" }, { type: "step.failed", step: "check", reason: "unavailable" }])

  expect(next.state).toEqual({ status: "closing", step: "releasing" })
  expect(next.effects).toContainEqual({ type: "join.timer.clear" })
  expect(next.effects).toContainEqual({ type: "release.recognition" })
  expect(next.effects).toContainEqual({ type: "join.reject", reason: "unavailable" })
})

test("a failed step for another step is ignored", () => {
  const next = replay([{ type: "join" }, { type: "step.failed", step: "starting", reason: "offline" }])

  expect(next.state).toEqual({ status: "connecting", step: { type: "check" } })
  expect(next.effects).toEqual([
    { type: "join.timer.start", ms: BROWSER_DICTATION_JOIN_TIMEOUT },
    { type: "check.availability" },
  ])
})

test("a join timeout rejects the join as a connection failure", () => {
  const next = replay([{ type: "join" }, { type: "join.timeout" }])

  expect(next.state).toEqual({ status: "closing", step: "releasing" })
  expect(next.effects).toContainEqual({ type: "join.reject", reason: "connection" })
})

test("closing while connecting rejects the join", () => {
  const next = replay([{ type: "join" }, { type: "close" }])

  expect(next.state).toEqual({ status: "closing", step: "releasing" })
  expect(next.effects).toContainEqual({ type: "join.reject", reason: "connection" })
})

test("transcript events forward while live without changing state", () => {
  const live = replay([{ type: "join" }, { type: "check.ready" }, { type: "recognition.started" }]).state
  const next = transitionBrowserDictation(live, { type: "recognition.result", event: transcriptDelta })

  expect(next.state).toBe(live)
  expect(next.effects).toEqual([{ type: "forward.event", event: transcriptDelta }])
})

test("a clean end while live restarts the recognition", () => {
  const live = replay([{ type: "join" }, { type: "check.ready" }, { type: "recognition.started" }]).state
  const next = transitionBrowserDictation(live, { type: "recognition.ended" })

  expect(next.state).toBe(live)
  expect(next.effects).toEqual([{ type: "restart.recognition" }])
})

test("an error while live drops the recording", () => {
  const live = replay([{ type: "join" }, { type: "check.ready" }, { type: "recognition.started" }]).state
  const next = transitionBrowserDictation(live, { type: "recognition.error" })

  expect(next.state).toEqual({ status: "closing", step: "releasing" })
  expect(next.effects).toContainEqual({ type: "stop.recognition" })
  expect(next.effects).toContainEqual({ type: "notify.dropped" })
})

test("closing a live session stops the recognition and waits for its end", () => {
  const live = replay([{ type: "join" }, { type: "check.ready" }, { type: "recognition.started" }]).state
  const next = transitionBrowserDictation(live, { type: "close" })

  expect(next.state).toEqual({ status: "closing", step: "releasing" })
  expect(next.effects).toEqual([{ type: "stop.recognition" }])

  const ended = transitionBrowserDictation(next.state, { type: "recognition.ended" })

  expect(ended.state).toEqual({ status: "closing", step: "releasing" })
  expect(ended.effects).toEqual([{ type: "release.recognition" }])

  const released = transitionBrowserDictation(ended.state, { type: "recognition.released" })

  expect(released.state).toEqual({ status: "closed" })
  expect(released.effects).toEqual([{ type: "close.resolve" }])
})

test("a final transcript after stop still forwards while closing", () => {
  const closing = replay([
    { type: "join" },
    { type: "check.ready" },
    { type: "recognition.started" },
    { type: "close" },
  ]).state
  const next = transitionBrowserDictation(closing, { type: "recognition.result", event: transcriptDelta })

  expect(next.state).toBe(closing)
  expect(next.effects).toEqual([{ type: "forward.event", event: transcriptDelta }])
})
