import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { PreviewTool } from "@opencode/core/tool/plugin/preview"
import { FSUtil } from "@opencode/util/fs-util"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { location } from "./fixture/location"
import { withTempDir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, registerToolPlugin, toolDefinitions } from "./lib/tool"

const previewToolNode = makeLocationNode({
  name: "test/preview-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(PreviewTool.Plugin)),
  deps: [Tool.node, Location.node, FSUtil.node],
})

const sessionID = Session.ID.make("ses_preview_tool_test")

const withTool = <A, E, R>(
  directory: string,
  body: (registry: Tool.Interface) => Effect.Effect<A, E, R>,
) => {
  const activeLocation = Layer.succeed(
    Location.Service,
    Location.Service.of(location({ directory: AbsolutePath.make(directory) })),
  )
  return Effect.gen(function* () {
    const registry = yield* Tool.Service
    return yield* body(registry)
  }).pipe(
    Effect.provide(
      AppNodeBuilder.build(LayerNode.group([Tool.node, previewToolNode]), [
        Location.node.replace(activeLocation),
      ]),
    ),
  )
}

const call = (input: typeof PreviewTool.Input.Type, id = "call-preview") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: "preview", input },
})

const it = testEffect(Layer.empty)

describe("PreviewTool", () => {
  it.live("registers and opens the entry index.html when no path is given", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "index.html")
      return Effect.promise(() => fs.writeFile(target, "<h1>oi</h1>")).pipe(
        Effect.andThen(
          withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toEqual(["preview", "execute"])
              const settled = yield* executeTool(registry, call({}))
              expect(settled.status).toBe("completed")
              if (settled.status !== "completed") return
              expect(settled.output).toEqual({ path: "index.html" })
              expect(settled.content).toEqual([{ type: "text", text: "Opened preview for index.html." }])
              expect(settled.metadata).toEqual({ path: "index.html" })
            }),
          ),
        ),
      )
    }),
  )

  it.live("opens public/index.html when the root entry file is missing", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "public", "index.html")
      return Effect.promise(() => fs.mkdir(path.join(tmp.path, "public"))).pipe(
        Effect.andThen(() => Effect.promise(() => fs.writeFile(target, "<h1>oi</h1>"))),
        Effect.andThen(
          withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              const settled = yield* executeTool(registry, call({}))
              expect(settled.status).toBe("completed")
              if (settled.status !== "completed") return
              expect(settled.output).toEqual({ path: "public/index.html" })
              expect(settled.metadata).toEqual({ path: "public/index.html" })
            }),
          ),
        ),
      )
    }),
  )

  it.live("opens the given entry file", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "loja.html")
      return Effect.promise(() => fs.writeFile(target, "<h1>oi</h1>")).pipe(
        Effect.andThen(
          withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              const settled = yield* executeTool(registry, call({ path: "loja.html" }))
              expect(settled.status).toBe("completed")
              if (settled.status !== "completed") return
              expect(settled.output).toEqual({ path: "loja.html" })
              expect(settled.metadata).toEqual({ path: "loja.html" })
            }),
          ),
        ),
      )
    }),
  )

  it.live("accepts a file:// URI for the entry file", () =>
    withTempDir((tmp) => {
      const target = path.join(tmp.path, "loja.html")
      return Effect.promise(() => fs.writeFile(target, "<h1>oi</h1>")).pipe(
        Effect.andThen(
          withTool(tmp.path, (registry) =>
            Effect.gen(function* () {
              const settled = yield* executeTool(registry, call({ path: `file://${target}` }))
              expect(settled.status).toBe("completed")
              if (settled.status !== "completed") return
              expect(settled.output).toEqual({ path: "loja.html" })
            }),
          ),
        ),
      )
    }),
  )

  it.live("fails when the project has no entry file", () =>
    withTempDir((tmp) =>
      withTool(tmp.path, (registry) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(registry, call({}))
          expect(settled.status).toBe("error")
        }),
      ),
    ),
  )

  it.live("fails when the given entry file does not exist", () =>
    withTempDir((tmp) =>
      withTool(tmp.path, (registry) =>
        Effect.gen(function* () {
          const settled = yield* executeTool(registry, call({ path: "ausente.html" }))
          expect(settled.status).toBe("error")
        }),
      ),
    ),
  )
})
