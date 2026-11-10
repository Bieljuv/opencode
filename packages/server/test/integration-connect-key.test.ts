import { expect } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpEffect, HttpRouter, HttpServer } from "effect/http"
import { tmpdirScoped } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

// Regression: the desktop connects the gateway key 2s after the server
// starts, on a location that has never been used. Plugin activation for a
// cold location runs asynchronously, so a connect issued before it settles
// used to read an empty integration registry and answer 404 — the gateway
// never connected and its model never entered the router chain. The
// handler must wait for activation like integration.list already does.
it.live("integration connect.key waits for plugin activation on a cold location", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped("opencode-integration-connect-key-")
    const context = yield* Layer.build(
      createRoutes({
        password: "secret",
        database: { path: ":memory:" },
        models: { fetch: false },
        fs: { filewatcher: false },
        config: {
          directory: tmp.path,
          project: false,
          content: JSON.stringify({}),
        },
      }).pipe(Layer.provide(HttpServer.layerServices)),
    )
    const handler = Context.get(context, HttpRouter.HttpRouter)
      .asHttpEffect()
      .pipe(HttpEffect.toWebHandlerWith(context))
    const request = (method: "GET" | "POST", route: string, body?: unknown) =>
      Effect.promise(async (signal) => {
        const url = new URL(route, "http://opencode.local")
        url.searchParams.set("location[directory]", tmp.path)
        const response = await handler(
          new Request(url, {
            method,
            headers: {
              authorization: `Basic ${btoa("opencode:secret")}`,
              ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal,
          }),
        )
        return { status: response.status, body: response.status === 204 ? undefined : await response.json() }
      })

    // First request to this location: it boots here, while its plugins are
    // still activating. The connect must wait and succeed, not 404.
    const connected = yield* request("POST", "/api/integration/manostech/connect/key", {
      key: "test-key",
      answer: { gatewayUrl: "https://gw.exemplo/v1" },
    })
    expect(connected.status).toBe(204)

    const integration = yield* request("GET", "/api/integration/manostech")
    expect(integration.status).toBe(200)
    expect(integration.body.data.id).toBe("manostech")
    expect(integration.body.data.connections).toHaveLength(1)
    expect(integration.body.data.connections[0].type).toBe("credential")
  }),
)
