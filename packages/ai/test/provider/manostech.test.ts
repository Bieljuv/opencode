import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { HttpClientRequest } from "effect/http"
import { ai, ImageClient } from "../../src/effect.js"
import { ManosTech } from "../../src/providers/manostech.js"
import { it } from "../lib/effect.js"
import { dynamicResponse, json, observe, type Call } from "../lib/http.js"

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

  it.effect("carries the turn complexity to the gateway on the wire", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = []
      const capture = dynamicResponse((input) =>
        Effect.gen(function* () {
          yield* observe(calls, input)
          return input.respond("", { status: 500 })
        }),
      )
      // The router classifies the turn in the app; the primary request
      // carries it as an http.body overlay, merged over the provider
      // body after validation — the gateway reads it as
      // `manostech_complexidade` and routes a complex turn to its paid
      // head first instead of treating every turn as simple.
      yield* ai
        .generate(
          ai.request({
            model: ManosTech.configure({ apiKey: "key-1" }).model("auto"),
            prompt: "Hi",
            http: { body: { manostech_complexidade: "complexa" } },
          }),
        )
        .pipe(Effect.provide(capture), Effect.ignore)
      expect(calls).toHaveLength(1)
      const body = JSON.parse(calls[0]!.body) as Record<string, unknown>
      expect(body.model).toBe("auto")
      expect(body.manostech_complexidade).toBe("complexa")
    }),
  )

  it.effect("posts image generations to the panel's live /v1 gateway as the gateway model", () =>
    Effect.gen(function* () {
      const calls: Array<Call> = []
      const capture = ImageClient.layer.pipe(
        Layer.provideMerge(
          dynamicResponse((input) =>
            Effect.gen(function* () {
              yield* observe(calls, input)
              return json(input, { data: [{ b64_json: "AQID" }] })
            }),
          ),
        ),
      )
      const response = yield* ai.image
        .generate({
          model: ManosTech.imageModel("auto-image", { apiKey: "key-1", body: { model: "manostech-auto" } }),
          prompt: "A lighthouse",
        })
        .pipe(Effect.provide(capture))
      // The images route hangs off the same /v1 base as chat.
      expect(calls.map((call) => call.url)).toEqual([
        "https://painel-manostech.manostech.workers.dev/v1/images/generations",
      ])
      // The app-side id "auto-image" never reaches the gateway: the
      // catalog model's body overlay rewrites it to "manostech-auto",
      // the only model the gateway's /v1/images/generations accepts.
      expect(calls.map((call) => JSON.parse(call.body))).toEqual([
        { model: "manostech-auto", prompt: "A lighthouse", response_format: "b64_json" },
      ])
      expect(response.images).toHaveLength(1)
    }),
  )
})
