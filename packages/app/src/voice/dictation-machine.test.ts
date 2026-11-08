import { expect, test } from "bun:test"
import {
  createDictationTransportState,
  DICTATION_CLOSE_TIMEOUT,
  DICTATION_JOIN_TIMEOUT,
  transitionDictationTransport,
  type DictationTransportEffect,
  type DictationTransportEvent,
  type DictationTransportState,
} from "./dictation-machine"

function replay(events: DictationTransportEvent[], start: DictationTransportState = createDictationTransportState()) {
  return events.reduce(
    (result: { state: DictationTransportState; effects: DictationTransportEffect[] }, event) => {
      const next = transitionDictationTransport(result.state, event)

      return { state: next.state, effects: [...result.effects, ...next.effects] }
    },
    { state: start, effects: [] },
  )
}

const transcriptDelta = { type: "conversation.item.input_audio_transcription.delta", delta: "olá " } as const

test("join starts the offer step with a join timer", () => {
  const next = transitionDictationTransport(createDictationTransportState(), { type: "join" })

  expect(next.state).toEqual({ status: "connecting", step: { type: "offer" } })
  expect(next.effects).toEqual([
    { type: "join.timer.start", ms: DICTATION_JOIN_TIMEOUT },
    { type: "prepare.offer" },
  ])
})

test("join from a non-idle state is ignored", () => {
  const started = replay([{ type: "join" }]).state

  expect(transitionDictationTransport(started, { type: "join" }).state).toBe(started)
})

test("offer waits for ICE gathering before negotiating", () => {
  const next = replay([{ type: "join" }, { type: "offer.ready", iceComplete: false }])

  expect(next.state).toEqual({ status: "connecting", step: { type: "ice" } })
  expect(next.effects).not.toContainEqual({ type: "negotiate" })

  const negotiated = transitionDictationTransport(next.state, { type: "ice.complete" })

  expect(negotiated.state).toEqual({ status: "connecting", step: { type: "negotiating" } })
  expect(negotiated.effects).toEqual([{ type: "negotiate" }])
})

test("a complete offer negotiates right away", () => {
  const next = replay([{ type: "join" }, { type: "offer.ready", iceComplete: true }])

  expect(next.state).toEqual({ status: "connecting", step: { type: "negotiating" } })
  expect(next.effects).toContainEqual({ type: "negotiate" })
})

test("the happy path reaches live once the microphone is ready", () => {
  const next = replay([
    { type: "join" },
    { type: "offer.ready", iceComplete: true },
    { type: "answer.applied" },
    { type: "mic.ready" },
  ])

  expect(next.state).toEqual({ status: "live" })
  expect(next.effects).toContainEqual({ type: "join.timer.clear" })
  expect(next.effects).toContainEqual({ type: "join.resolve" })
})

test("answer before negotiating is ignored", () => {
  const next = replay([{ type: "join" }, { type: "answer.applied" }])

  expect(next.state).toEqual({ status: "connecting", step: { type: "offer" } })
  expect(next.effects).not.toContainEqual({ type: "acquire.mic" })
})

test("a failed step rejects the join and releases the peer", () => {
  const next = replay([{ type: "join" }, { type: "step.failed", step: "offer", reason: "unavailable" }])

  expect(next.state).toEqual({ status: "closing", step: "releasing" })
  expect(next.effects).toContainEqual({ type: "join.timer.clear" })
  expect(next.effects).toContainEqual({ type: "stop.media" })
  expect(next.effects).toContainEqual({ type: "release.peer" })
  expect(next.effects).toContainEqual({ type: "join.reject", reason: "unavailable" })
})

test("a failed step for another step is ignored", () => {
  const next = replay([{ type: "join" }, { type: "step.failed", step: "mic", reason: "microphone" }])

  expect(next.state).toEqual({ status: "connecting", step: { type: "offer" } })
  expect(next.effects).toEqual([
    { type: "join.timer.start", ms: DICTATION_JOIN_TIMEOUT },
    { type: "prepare.offer" },
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
  const live = replay([
    { type: "join" },
    { type: "offer.ready", iceComplete: true },
    { type: "answer.applied" },
    { type: "mic.ready" },
  ]).state
  const next = transitionDictationTransport(live, { type: "channel.message", event: transcriptDelta })

  expect(next.state).toBe(live)
  expect(next.effects).toEqual([{ type: "forward.event", event: transcriptDelta }])
})

test("an error while live drops the recording", () => {
  const live = replay([
    { type: "join" },
    { type: "offer.ready", iceComplete: true },
    { type: "answer.applied" },
    { type: "mic.ready" },
  ]).state
  const next = transitionDictationTransport(live, {
    type: "channel.message",
    event: { type: "error", error: { type: "invalid_request_error", code: "invalid", message: "bad session" } },
  })

  expect(next.state).toEqual({ status: "closing", step: "handshake" })
  expect(next.effects).toContainEqual({ type: "notify.dropped" })
})

test("the server closing the session drops the recording", () => {
  const live = replay([
    { type: "join" },
    { type: "offer.ready", iceComplete: true },
    { type: "answer.applied" },
    { type: "mic.ready" },
  ]).state
  const next = transitionDictationTransport(live, {
    type: "channel.message",
    event: { type: "session.closed" },
  })

  expect(next.state).toEqual({ status: "closing", step: "releasing" })
  expect(next.effects).toContainEqual({ type: "notify.dropped" })
})

test("closing a live session says goodbye before releasing the peer", () => {
  const live = replay([
    { type: "join" },
    { type: "offer.ready", iceComplete: true },
    { type: "answer.applied" },
    { type: "mic.ready" },
  ]).state
  const next = transitionDictationTransport(live, { type: "close" })

  expect(next.state).toEqual({ status: "closing", step: "handshake" })
  expect(next.effects).toContainEqual({ type: "stop.media" })
  expect(next.effects).toContainEqual({ type: "close.handshake.start", ms: DICTATION_CLOSE_TIMEOUT })
  expect(next.effects).not.toContainEqual({ type: "release.peer" })

  const released = transitionDictationTransport(next.state, { type: "close.timeout" })

  expect(released.state).toEqual({ status: "closing", step: "releasing" })
  expect(released.effects).toEqual([{ type: "release.peer" }])

  const closed = transitionDictationTransport(released.state, { type: "peer.released" })

  expect(closed.state).toEqual({ status: "closed" })
  expect(closed.effects).toEqual([{ type: "close.resolve" }])
})

test("a closed channel while handshaking releases the peer right away", () => {
  const closing = replay([
    { type: "join" },
    { type: "offer.ready", iceComplete: true },
    { type: "answer.applied" },
    { type: "mic.ready" },
    { type: "close" },
  ]).state
  const next = transitionDictationTransport(closing, { type: "channel.closed" })

  expect(next.state).toEqual({ status: "closing", step: "releasing" })
  expect(next.effects).toEqual([{ type: "close.timer.clear" }, { type: "release.peer" }])
})
