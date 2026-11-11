import { $ } from "bun"
import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Model } from "@opencode/core/model"
import { Plugin } from "@opencode/core/plugin"
import { Provider } from "@opencode/core/provider"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionEvent } from "@opencode/core/session/event"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionInbox } from "@opencode/core/session/inbox"
import { SessionMessage } from "@opencode/core/session/message"
import { SessionProjector } from "@opencode/core/session/projector"
import { Snapshot } from "@opencode/core/snapshot"
import { Money } from "@opencode/schema/money"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { tempGlobalLayer } from "./fixture/global"
import { offlineModels } from "./fixture/models"
import { tmpdirScoped } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, Session.node, LocationServiceMap.node]),
    [
      Bus.node.replace(Bus.configured({ persist: true })),
      Global.node.replace(tempGlobalLayer),
      SessionExecution.node.replace(SessionExecution.noopLayer),
      offlineModels,
    ],
  ),
)

describe("Session.revert files", () => {
  it.live(
    "undoes and restores a file rename without losing either path",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        const original = path.join(directory, "old name.txt")
        const renamed = path.join(directory, "new name.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(directory)
          await Bun.write(original, "Preserve this content.\n")
          await Bun.write(path.join(directory, "unrelated.txt"), "Unrelated content.\n")
          await $`git init -q`.cwd(directory).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
        })

        const session = yield* Session.Service
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        const prompt = yield* session.prompt({ sessionID: created.id, text: "Rename the file", resume: false })
        yield* SessionInbox.promote(database.db, bus, created.id, "steer")

        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const snapshot = yield* Snapshot.Service
          const before = yield* snapshot.capture()
          if (!before) throw new Error("Initial snapshot missing")
          const assistantMessageID = SessionMessage.ID.create()
          yield* bus.publish(SessionEvent.Step.Started, {
            sessionID: created.id,
            assistantMessageID,
            agent: Agent.defaultID,
            model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
            snapshot: before,
            started: 0,
          })
          yield* Effect.promise(() => fs.rename(original, renamed))
          const after = yield* snapshot.capture()
          if (!after) throw new Error("Renamed snapshot missing")
          yield* bus.publish(SessionEvent.Step.Ended, {
            sessionID: created.id,
            assistantMessageID,
            finish: "stop",
            cost: Money.USD.zero,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            snapshot: after,
            files: yield* snapshot.files({ from: before, to: after }),
          })

          yield* Effect.promise(() => Bun.write(path.join(directory, "unrelated.txt"), "Keep this later edit.\n"))
          const reverted = yield* session.revert.stage({ sessionID: created.id, messageID: prompt.id })
          expect({
            original: yield* Effect.promise(() => Bun.file(original).exists()),
            renamed: yield* Effect.promise(() => Bun.file(renamed).exists()),
          }).toEqual({ original: true, renamed: false })
          expect(yield* Effect.promise(() => Bun.file(original).text())).toBe("Preserve this content.\n")
          expect(reverted.files?.map((file) => [file.file, file.status])).toEqual([
            ["new name.txt", "deleted"],
            ["old name.txt", "added"],
          ])
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "unrelated.txt")).text())).toBe(
            "Keep this later edit.\n",
          )

          yield* session.revert.clear(created.id)
          expect(yield* Effect.promise(() => Bun.file(original).exists())).toBe(false)
          expect(yield* Effect.promise(() => Bun.file(renamed).text())).toBe("Preserve this content.\n")
          expect(yield* Effect.promise(() => Bun.file(path.join(directory, "unrelated.txt")).text())).toBe(
            "Keep this later edit.\n",
          )
          expect((yield* session.get(created.id)).revert).toBeUndefined()
        }).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))
      }),
    // Real Location/plugin startup and Git snapshots can exceed five seconds under CI load.
    { timeout: 15_000 },
  )
  it.live(
    "undoes one edit at a time without touching the other files",
    () =>
      Effect.gen(function* () {
        const tmp = yield* tmpdirScoped()
        const directory = path.join(tmp.path, "project")
        const one = path.join(directory, "one.txt")
        const two = path.join(directory, "two.txt")
        const keep = path.join(directory, "keep.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(directory)
          await Bun.write(one, "one v1\n")
          await Bun.write(two, "two v1\n")
          await Bun.write(keep, "keep v1\n")
          await $`git init -q`.cwd(directory).quiet()
          await $`git -c core.fsmonitor=false add .`.cwd(directory).quiet()
        })

        const session = yield* Session.Service
        const database = yield* Database.Service
        const bus = yield* Bus.Service
        const created = yield* session.create({ location: { directory: AbsolutePath.make(directory) } })
        yield* session.prompt({ sessionID: created.id, text: "Edit the files", resume: false })
        yield* SessionInbox.promote(database.db, bus, created.id, "steer")

        const read = (name: string) => Effect.promise(() => Bun.file(path.join(directory, name)).text())

        yield* Effect.gen(function* () {
          const plugins = yield* Plugin.Service
          yield* plugins.awaitActivation
          const snapshot = yield* Snapshot.Service
          const firstID = SessionMessage.ID.create()
          const secondID = SessionMessage.ID.create()

          const runStep = (assistantMessageID: SessionMessage.ID, edit: () => Promise<unknown>) =>
            Effect.gen(function* () {
              const before = yield* snapshot.capture()
              if (!before) throw new Error("Step snapshot missing")
              yield* bus.publish(SessionEvent.Step.Started, {
                sessionID: created.id,
                assistantMessageID,
                agent: Agent.defaultID,
                model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
                snapshot: before,
                started: 0,
              })
              yield* Effect.promise(edit)
              const after = yield* snapshot.capture()
              if (!after) throw new Error("Step snapshot missing")
              yield* bus.publish(SessionEvent.Step.Ended, {
                sessionID: created.id,
                assistantMessageID,
                finish: "stop",
                cost: Money.USD.zero,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                snapshot: after,
                files: yield* snapshot.files({ from: before, to: after }),
              })
            })

          yield* runStep(firstID, async () => {
            await Bun.write(one, "one v2\n")
            await Bun.write(two, "two v2\n")
          })
          yield* runStep(secondID, () => Bun.write(keep, "keep v2\n"))

          // The newest edit goes first, and only that file moves.
          const undoneKeep = yield* session.revert.undoLastEdit(created.id)
          expect(undoneKeep).toEqual({ messageID: secondID, file: "keep.txt" })
          expect(yield* read("keep.txt")).toBe("keep v1\n")
          expect(yield* read("one.txt")).toBe("one v2\n")
          expect(yield* read("two.txt")).toBe("two v2\n")

          // Repeating it walks back through the earlier step, one file at a time.
          const undoneFirst = yield* session.revert.undoLastEdit(created.id)
          expect(undoneFirst?.messageID).toBe(firstID)
          const undoneFile = undoneFirst?.file
          expect(["one.txt", "two.txt"]).toContain(undoneFile!)
          const remaining = undoneFile === "one.txt" ? "two.txt" : "one.txt"
          expect(yield* read(undoneFile!)).toBe(`${undoneFile === "one.txt" ? "one" : "two"} v1\n`)
          expect(yield* read(remaining)).toBe(`${remaining === "one.txt" ? "one" : "two"} v2\n`)

          // Undoing the specific remaining edit by file leaves the rest alone.
          const undoneSpecific = yield* session.revert.undoEdit({
            sessionID: created.id,
            messageID: firstID,
            file: remaining,
          })
          expect(undoneSpecific).toEqual({ messageID: firstID, file: remaining })
          expect(yield* read(remaining)).toBe(`${remaining === "one.txt" ? "one" : "two"} v1\n`)

          // Nothing left to undo, and an edit already undone reports nothing.
          expect(yield* session.revert.undoLastEdit(created.id)).toBeUndefined()
          expect(
            yield* session.revert.undoEdit({ sessionID: created.id, messageID: firstID, file: "one.txt" }),
          ).toBeUndefined()
          expect(
            yield* session.revert.undoEdit({ sessionID: created.id, messageID: firstID, file: "keep.txt" }),
          ).toBeUndefined()
        }).pipe(Effect.provide(LocationServiceMap.Service.get(created.location)))
      }),
    { timeout: 15_000 },
  )
})
