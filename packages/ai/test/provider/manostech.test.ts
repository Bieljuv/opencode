import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai } from "../../src/effect.js"
import { ManosTech } from "../../src/providers/manostech.js"
import { it } from "../lib/effect.js"
import { dynamicResponse } from "../lib/http.js"

describe("ManosTech", () => {
  it.effect("posts to the panel's live /v1 gateway by default", () =>
    Effect.gen(function* () {
      const requests: Array<Request> = []
      const capture = dynamicResponse((input) =>
        Effect.gen(function* () {
          requests.push(yield* HttpClientRequest.toWeb(input.request).pipe(Effect.orDie))
          return input.respond("", { status: 500 })
        }),
      )
      yield* ai
        .generate(ai.request({ model: ManosTech.configure({ apiKey: "key-1" }).model("auto"), prompt: "Hi" }))
        .pipe(Effect.provide(capture), Effect.ignore)
      // The panel serves the OpenAI-compatible API at /v1; /api/gateway
      // does not exist and answers 404, so the default base URL must end
      // in /v1 and the route appends /chat/completions.
      expect(requests.map((request) => request.url)).toEqual([
        "https://painel-manostech.manostech.workers.dev/v1/chat/completions",
      ])
    }),
  )
})
