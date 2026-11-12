import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Command } from "@opencode/core/command"
import { Bus } from "@opencode/core/bus"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { CommandPlugin } from "@opencode/core/plugin/command"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { DateTime } from "effect"
import { emptyMcpLayer } from "../fixture/mcp"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "./host"
import PROMPT_INITIALIZE from "../../src/plugin/command/initialize.txt"
import PROMPT_REVIEW from "../../src/plugin/command/review.txt"

const directory = AbsolutePath.make("/repo/packages/app")
const project = AbsolutePath.make("/repo")
const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory }, { projectDirectory: project })),
)
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Command.node, Mcp.node, Bus.node]), [
    Mcp.node.replace(emptyMcpLayer),
    Location.node.replace(locationLayer),
  ]),
)

describe("CommandPlugin.Plugin", () => {
  function setupPlugin(prompts: {
    text: string
    files?: readonly { readonly uri: string }[]
    delivery?: "steer" | "queue"
  }[]) {
    return Effect.gen(function* () {
      const command = yield* Command.Service
      yield* CommandPlugin.Plugin.effect(
        host({
          command: {
            list: () => Effect.die("unused command.list"),
            transform: command.transform,
            reload: command.reload,
          },
          session: {
            prompt: (input) =>
              Effect.sync(() => {
                prompts.push({ text: input.text, files: input.files, delivery: input.delivery })
                return SessionInbox.User.make({
                  id: SessionMessage.ID.make("msg_test"),
                  sessionID: input.sessionID,
                  time: { created: DateTime.makeUnsafe(0) },
                  type: "user",
                  payload: { text: input.text },
                  delivery: input.delivery ?? "steer",
                })
              }),
          },
        }),
      ).pipe(
        Effect.provideService(
          Location.Service,
          Location.Service.of(location({ directory }, { projectDirectory: project })),
        ),
      )

      return command
    })
  }

  it.effect("registers built-in init and review commands", () =>
    Effect.gen(function* () {
      const prompts: {
        text: string
        files?: readonly { readonly uri: string }[]
        delivery?: "steer" | "queue"
      }[] = []
      const command = yield* setupPlugin(prompts)

      expect(yield* command.get("init")).toMatchObject({
        name: "init",
        description: "guided AGENTS.md setup",
      })
      expect(yield* command.get("review")).toMatchObject({
        name: "review",
        description: "review changes [commit|branch|pr], defaults to uncommitted",
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "extra context", files: [{ uri: "file:///tmp/context.md" }] },
          delivery: "queue",
        },
      })
      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "  branch $& $$ $` $'  " },
          delivery: "steer",
        },
      })
      yield* command.execute({
        name: "init",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "" },
          delivery: "steer",
        },
      })
      yield* command.execute({
        name: "review",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "   " },
          delivery: "steer",
        },
      })
      expect(prompts).toEqual([
        {
          text: PROMPT_INITIALIZE.replace("${path}", project).replaceAll("$ARGUMENTS", "extra context"),
          files: [{ uri: "file:///tmp/context.md" }],
          delivery: "queue",
        },
        {
          text: PROMPT_REVIEW.replace("${path}", project).replaceAll("$ARGUMENTS", () => "branch $& $$ $` $'"),
          files: undefined,
          delivery: "steer",
        },
        {
          text: PROMPT_INITIALIZE.replace("${path}", project).replaceAll("$ARGUMENTS", ""),
          files: undefined,
          delivery: "steer",
        },
        {
          text: PROMPT_REVIEW.replace("${path}", project).replaceAll("$ARGUMENTS", ""),
          files: undefined,
          delivery: "steer",
        },
      ])
    }),
  )

  it.effect("publicar injects the connections block from the desktop env", () =>
    Effect.gen(function* () {
      const prompts: { text: string }[] = []
      process.env.MANOSTECH_CONNECTIONS_AVAILABLE = "1"
      process.env.MANOSTECH_CONN_GITHUB_CONNECTED = "1"
      process.env.MANOSTECH_CONN_GITHUB_LOGIN = "gabriel"

      try {
        const command = yield* setupPlugin(prompts)

        expect(yield* command.get("publicar")).toMatchObject({
          name: "publicar",
          description: "guided publish: check the project, then publish it step by step with the user",
        })
        yield* command.execute({
          name: "publicar",
          invocation: {
            sessionID: Session.ID.make("ses_test"),
            prompt: { text: "quero publicar" },
            delivery: "steer",
          },
        })

        expect(prompts).toHaveLength(1)
        expect(prompts[0].text).toContain("## Conexões da conta do cliente")
        expect(prompts[0].text).toContain("- GitHub: conectado como gabriel")
        expect(prompts[0].text).toContain("- Vercel: não conectado")
        expect(prompts[0].text).toContain("- Supabase: não conectado")
        expect(prompts[0].text).toContain("quero publicar")
        expect(prompts[0].text).not.toContain("$CONEXOES")
      } finally {
        delete process.env.MANOSTECH_CONNECTIONS_AVAILABLE
        delete process.env.MANOSTECH_CONN_GITHUB_CONNECTED
        delete process.env.MANOSTECH_CONN_GITHUB_LOGIN
      }
    }),
  )

  it.effect("publicar without the desktop env shows no connections section", () =>
    Effect.gen(function* () {
      const prompts: { text: string }[] = []
      delete process.env.MANOSTECH_CONNECTIONS_AVAILABLE
      delete process.env.MANOSTECH_CONN_GITHUB_CONNECTED
      delete process.env.MANOSTECH_CONN_GITHUB_LOGIN
      delete process.env.MANOSTECH_CONN_VERCEL_CONNECTED
      delete process.env.MANOSTECH_CONN_SUPABASE_CONNECTED

      const command = yield* setupPlugin(prompts)
      yield* command.execute({
        name: "publicar",
        invocation: {
          sessionID: Session.ID.make("ses_test"),
          prompt: { text: "quero publicar" },
          delivery: "steer",
        },
      })

      expect(prompts).toHaveLength(1)
      expect(prompts[0].text).not.toContain("Conexões da conta do cliente")
      expect(prompts[0].text).not.toContain("$CONEXOES")
      expect(prompts[0].text).toContain("quero publicar")
    }),
  )
})
