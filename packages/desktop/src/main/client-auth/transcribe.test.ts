import { afterEach, beforeEach, expect, test } from "bun:test"
import { parseAudioDataUrl, transcribeSlice } from "./transcribe"

const AUDIO_B64 = Buffer.from("fake-webm-audio").toString("base64")
const AUDIO_DATA_URL = `data:audio/webm;base64,${AUDIO_B64}`

type SeenRequest = {
  path: string
  authorization: string | null
  body: string
}

/** A mock of the panel gateway: records the transcription requests and answers canned text. */
let server: ReturnType<typeof Bun.serve>
let requests: SeenRequest[]
let answer: { status: number; body: unknown }

beforeEach(() => {
  requests = []
  answer = { status: 200, body: { text: "olá" } }
  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const body = Buffer.from(await request.arrayBuffer()).toString("latin1")
      requests.push({
        path: new URL(request.url).pathname,
        authorization: request.headers.get("authorization"),
        body,
      })

      return Response.json(answer.body, { status: answer.status })
    },
  })
})

afterEach(() => {
  server.stop(true)
})

const gatewayUrl = () => `http://127.0.0.1:${server.port}/v1`

test("posts the slice as multipart with the client key and returns the text", async () => {
  const result = await transcribeSlice({ apiKey: "client-key", gatewayUrl: gatewayUrl(), audioDataUrl: AUDIO_DATA_URL })

  expect(result).toEqual({ ok: true, text: "olá" })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.path).toBe("/v1/audio/transcriptions")
  expect(requests[0]?.authorization).toBe("Bearer client-key")
  expect(requests[0]?.body).toContain('name="file"')
  expect(requests[0]?.body).toContain('filename="audio.webm"')
  expect(requests[0]?.body).toContain("Content-Type: audio/webm")
  expect(requests[0]?.body).toContain("fake-webm-audio")
  expect(requests[0]?.body).toContain('name="language"')
  expect(requests[0]?.body).toContain("pt")
})

test("silence comes back as an empty transcript", async () => {
  answer = { status: 200, body: { text: "   " } }

  const result = await transcribeSlice({ apiKey: "client-key", gatewayUrl: gatewayUrl(), audioDataUrl: AUDIO_DATA_URL })

  expect(result).toEqual({ ok: true, text: "" })
})

test("without a client key nothing is sent", async () => {
  const result = await transcribeSlice({ apiKey: undefined, gatewayUrl: gatewayUrl(), audioDataUrl: AUDIO_DATA_URL })

  expect(result).toEqual({ ok: false, error: "unavailable" })
  expect(requests).toHaveLength(0)
})

test("a gateway error is a plain failure, with no detail leaking", async () => {
  answer = { status: 500, body: { error: "quota exceeded for model whisper-1" } }

  const result = await transcribeSlice({ apiKey: "client-key", gatewayUrl: gatewayUrl(), audioDataUrl: AUDIO_DATA_URL })

  expect(result).toEqual({ ok: false, error: "failed" })
})

test("a malformed gateway answer is a failure", async () => {
  answer = { status: 200, body: { transcript: "olá" } }

  const result = await transcribeSlice({ apiKey: "client-key", gatewayUrl: gatewayUrl(), audioDataUrl: AUDIO_DATA_URL })

  expect(result).toEqual({ ok: false, error: "failed" })
})

test("an invalid audio data URL never reaches the gateway", async () => {
  const result = await transcribeSlice({ apiKey: "client-key", gatewayUrl: gatewayUrl(), audioDataUrl: "not-audio" })

  expect(result).toEqual({ ok: false, error: "failed" })
  expect(requests).toHaveLength(0)
})

test("parseAudioDataUrl accepts audio data URLs and rejects the rest", () => {
  expect(parseAudioDataUrl(AUDIO_DATA_URL)).toEqual({ mimeType: "audio/webm", data: AUDIO_B64 })
  expect(parseAudioDataUrl("data:text/plain;base64,AAAA")).toBeNull()
  expect(parseAudioDataUrl("")).toBeNull()
})
