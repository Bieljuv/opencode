import { afterEach, beforeEach, expect, jest, test } from "bun:test"
import type { ClientTranscribeResult } from "../runtime/platform/platform"
import { DictationFailure } from "./dictation-transport"
import { GATEWAY_DICTATION_SLICE_MS } from "./gateway-dictation-machine"
import { GatewayDictationTransport } from "./gateway-dictation-transport"
import type { VoiceEvent } from "./protocol"

// The MediaRecorder the transport drives: `stop()` delivers one chunk and ends the slice,
// like a real recorder, and throws when stopped twice — the transport must never do that.
class FakeMediaRecorder {
  static created: FakeMediaRecorder[] = []
  mimeType = "audio/webm"
  state: "inactive" | "recording" | "paused" = "inactive"
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor() {
    FakeMediaRecorder.created.push(this)
  }

  start() {
    if (this.state !== "inactive") throw new Error("InvalidStateError")
    this.state = "recording"
  }

  stop() {
    if (this.state !== "recording") throw new Error("InvalidStateError")
    this.state = "inactive"
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) })
    this.onstop?.()
  }
}

class FakeMediaStream {
  tracks = [track()]

  getTracks() {
    return this.tracks
  }

  getAudioTracks() {
    return this.tracks
  }
}

const track = () => ({
  readyState: "live" as MediaStreamTrackState,
  stopped: false,
  stop() {
    this.stopped = true
    this.readyState = "ended" as MediaStreamTrackState
  },
})

const globals = ["MediaRecorder", "MediaStream"] as const

const saved = globals.map((name) => Object.getOwnPropertyDescriptor(globalThis, name))
const savedMediaDevices = Object.getOwnPropertyDescriptor(navigator, "mediaDevices")

let microphone: PromiseWithResolvers<FakeMediaStream>
let stream: FakeMediaStream

beforeEach(() => {
  jest.useFakeTimers()
  FakeMediaRecorder.created = []
  microphone = Promise.withResolvers<FakeMediaStream>()
  stream = new FakeMediaStream()
  const fakes = [FakeMediaRecorder, FakeMediaStream] as const
  globals.forEach((name, index) =>
    Object.defineProperty(globalThis, name, { value: fakes[index], configurable: true, writable: true }),
  )
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: () => microphone.promise },
    configurable: true,
  })
})

afterEach(() => {
  jest.useRealTimers()
  const missing = { value: undefined, configurable: true, writable: true }
  globals.forEach((name, index) => Object.defineProperty(globalThis, name, saved[index] ?? missing))
  Object.defineProperty(navigator, "mediaDevices", savedMediaDevices ?? missing)
})

/** Lets the FileReader conversions and the transcription chain settle. */
async function flush() {
  for (let i = 0; i < 10; i++) {
    jest.advanceTimersByTime(0)
    await Promise.resolve()
  }
}

/** Closes the transport, letting the final slice settle first. */
async function closeTransport(transport: GatewayDictationTransport) {
  const closing = transport.close()
  await flush()
  await closing
  await flush()
}

function completedEvents(events: VoiceEvent[]) {
  return events
    .filter((event) => event.type === "conversation.item.input_audio_transcription.completed")
    .map((event) => event.transcript ?? "")
}

function createTransport(transcribe: (audioDataUrl: string) => Promise<ClientTranscribeResult>) {
  const events: VoiceEvent[] = []
  const failures: string[] = []
  const transport = new GatewayDictationTransport({
    event: (event) => events.push(event),
    failed: (reason) => failures.push(reason),
    transcribe,
  })

  return { transport, events, failures }
}

test("slices reach the gateway in order and the text reaches the composer", async () => {
  const seen: string[] = []
  const { transport, events } = createTransport(async (audioDataUrl) => {
    seen.push(audioDataUrl)
    return { ok: true, text: seen.length === 1 ? "olá" : "mundo" }
  })

  const joining = transport.join()
  microphone.resolve(stream)
  await joining
  await flush()

  jest.advanceTimersByTime(GATEWAY_DICTATION_SLICE_MS)
  await flush()
  jest.advanceTimersByTime(GATEWAY_DICTATION_SLICE_MS)
  await flush()

  expect(seen).toHaveLength(2)
  expect(seen[0]).toStartWith("data:audio/webm;base64,")
  expect(completedEvents(events)).toEqual(["olá", " mundo"])

  const closing = transport.close()
  await flush()
  await closing
  await flush()

  // The final slice (the partial one at stop) is transcribed too.
  expect(seen).toHaveLength(3)
  expect(stream.tracks[0]?.stopped).toBe(true)
})

test("slices are transcribed strictly in spoken order", async () => {
  const resolvers: Array<(text: string) => void> = []
  const { transport, events } = createTransport(
    () =>
      new Promise<ClientTranscribeResult>((resolve) => {
        resolvers.push((text) => resolve({ ok: true, text }))
      }),
  )

  const joining = transport.join()
  microphone.resolve(stream)
  await joining
  await flush()

  jest.advanceTimersByTime(GATEWAY_DICTATION_SLICE_MS)
  await flush()
  jest.advanceTimersByTime(GATEWAY_DICTATION_SLICE_MS)
  await flush()

  // The second slice is not even sent while the first one is unanswered: the chain
  // serializes the calls, so the text can never arrive out of order.
  expect(resolvers).toHaveLength(1)
  resolvers[0]?.("olá")
  await flush()
  expect(completedEvents(events)).toEqual(["olá"])
  expect(resolvers).toHaveLength(2)
  resolvers[1]?.("mundo")
  await flush()
  expect(completedEvents(events)).toEqual(["olá", " mundo"])

  const closing = transport.close()
  await flush()
  expect(resolvers).toHaveLength(3)
  resolvers[2]?.("!")
  await flush()
  await closing
  await flush()
})

test("a failed slice reports once and stops further attempts, but the recording continues", async () => {
  let calls = 0
  const { transport, events, failures } = createTransport(async () => {
    calls++
    return { ok: false, error: "failed" }
  })

  const joining = transport.join()
  microphone.resolve(stream)
  await joining
  await flush()

  jest.advanceTimersByTime(GATEWAY_DICTATION_SLICE_MS)
  await flush()
  jest.advanceTimersByTime(GATEWAY_DICTATION_SLICE_MS)
  await flush()

  // The failure is a transcription failure — never an internet claim.
  expect(failures).toEqual(["transcription"])
  expect(calls).toBe(1)
  expect(completedEvents(events)).toEqual([])

  // The microphone is still on: closing still works and settles.
  await closeTransport(transport)
  expect(calls).toBe(1)
})

test("a missing gateway key reports unavailable, not a connection error", async () => {
  const { transport, failures } = createTransport(async () => ({ ok: false, error: "unavailable" }))

  const joining = transport.join()
  microphone.resolve(stream)
  await joining
  await flush()

  jest.advanceTimersByTime(GATEWAY_DICTATION_SLICE_MS)
  await flush()

  expect(failures).toEqual(["unavailable"])
  await closeTransport(transport)
})

test("a denied microphone rejects the join", async () => {
  const { transport } = createTransport(async () => ({ ok: true, text: "" }))

  const joining = transport.join()
  microphone.reject(new Error("denied"))

  let reason: unknown
  try {
    await joining
  } catch (error) {
    reason = error instanceof DictationFailure ? error.reason : undefined
  }

  expect(reason).toBe("microphone")
})

test("a browser without MediaRecorder rejects the join as unavailable", async () => {
  delete (globalThis as Record<string, unknown>).MediaRecorder
  const { transport } = createTransport(async () => ({ ok: true, text: "" }))

  let reason: unknown
  try {
    await transport.join()
  } catch (error) {
    reason = error instanceof DictationFailure ? error.reason : undefined
  }

  expect(reason).toBe("unavailable")
})

test("closing before any slice still finalizes the partial slice", async () => {
  let calls = 0
  const { transport, events } = createTransport(async () => {
    calls++
    return { ok: true, text: "" }
  })

  const joining = transport.join()
  microphone.resolve(stream)
  await joining
  await flush()

  await closeTransport(transport)

  // The recorder stopped before the first slice boundary: the partial slice is still sent
  // (it comes back empty — silence), and the close settles.
  expect(calls).toBe(1)
  expect(completedEvents(events)).toEqual([])
  expect(stream.tracks[0]?.stopped).toBe(true)
})

test("a silent slice forwards nothing", async () => {
  const { transport, events } = createTransport(async () => ({ ok: true, text: "   " }))

  const joining = transport.join()
  microphone.resolve(stream)
  await joining
  await flush()

  jest.advanceTimersByTime(GATEWAY_DICTATION_SLICE_MS)
  await flush()

  expect(completedEvents(events)).toEqual([])
  await closeTransport(transport)
})
