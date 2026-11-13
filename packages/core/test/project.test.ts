import { describe, expect } from "bun:test"
import { $ } from "bun"
import fs from "fs/promises"
import { existsSync } from "node:fs"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { ProjectSchema } from "@opencode/core/project/schema"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Hash } from "@opencode/util/hash"
import { Global } from "@opencode/util/global"
import { initGit } from "./fixture/git"
import { countingSpawner } from "./fixture/spawn"
import { tmpdirScoped } from "./fixture/tmpdir"
import { advance } from "./lib/clock"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node, Global.node])))

describe("Project.list", () => {
  it.effect("returns complete projects ordered by recent activity", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      yield* db
        .insert(ProjectTable)
        .values([
          {
            id: Project.ID.make("older"),
            worktree: abs("/older"),
            vcs: "git",
            name: "Older",
            icon_color: "#000000",
            commands: { start: "bun dev" },
            sandboxes: [abs("/older/sandbox")],
            time_created: 1,
            time_updated: 1,
            time_active: 4,
          },
          {
            id: Project.ID.make("newer"),
            worktree: abs("/newer"),
            sandboxes: [],
            time_created: 2,
            time_updated: 2,
            time_initialized: 3,
            time_active: 3,
          },
        ])
        .run()

      expect(yield* project.list()).toEqual([
        {
          id: Project.ID.make("older"),
          canonical: abs("/older"),
          vcs: "git",
          name: "Older",
          icon: { color: "#000000" },
          commands: { start: "bun dev" },
          time: { created: 1, updated: 1, active: 4 },
          sandboxes: [abs("/older/sandbox")],
        },
        {
          id: Project.ID.make("newer"),
          canonical: abs("/newer"),
          time: { created: 2, updated: 2, active: 3 },
          sandboxes: [],
        },
      ])
    }),
  )
})

describe("Project.update", () => {
  it.effect("updates and clears project metadata", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      const id = Project.ID.make("update")
      yield* db
        .insert(ProjectTable)
        .values({
          id,
          worktree: abs("/update"),
          sandboxes: [],
          time_created: 1,
          time_updated: 1,
          time_active: 1,
        })
        .run()

      expect(
        yield* project.update({
          projectID: id,
          name: "Updated",
          icon: { color: "blue", override: "data:image/png;base64,test" },
          commands: { start: "bun install" },
        }),
      ).toMatchObject({
        id,
        name: "Updated",
        icon: { color: "blue", override: "data:image/png;base64,test" },
        commands: { start: "bun install" },
      })

      expect(
        yield* project.update({
          projectID: id,
          name: "",
          icon: { color: "", override: "" },
          commands: { start: "" },
        }),
      ).toMatchObject({ id })
      expect((yield* project.list())[0]).toEqual({
        id,
        canonical: abs("/update"),
        time: { created: 1, updated: expect.any(Number), active: 1 },
        sandboxes: [],
      })
    }),
  )
})

describe("Project.activate", () => {
  it.effect("records activity without editing metadata time and throttles repeats", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      const id = Project.ID.make("activate")
      yield* db
        .insert(ProjectTable)
        .values({ id, worktree: abs("/activate"), sandboxes: [], time_created: 1, time_updated: 1, time_active: 1 })
        .run()

      yield* project.activate(id)
      const first = (yield* project.list())[0]
      expect(first?.time.updated).toBe(1)
      expect(first?.time.active).toBeGreaterThan(1)

      yield* db.update(ProjectTable).set({ time_active: 2, time_updated: 1 }).run()
      yield* project.activate(id)
      expect((yield* project.list())[0]?.time).toEqual({ created: 1, updated: 1, active: 2 })
    }),
  )
})

describe("Project archiving", () => {
  it.effect("lists archived projects only when requested", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      yield* db
        .insert(ProjectTable)
        .values([
          { id: Project.ID.make("active"), worktree: abs("/active"), sandboxes: [], time_active: 2 },
          {
            id: Project.ID.make("archived"),
            worktree: abs("/archived"),
            sandboxes: [],
            time_active: 1,
            time_archived: 5,
          },
        ])
        .run()

      expect((yield* project.list()).map((item) => item.id)).toEqual([Project.ID.make("active")])
      const all = yield* project.list({ archived: true })
      expect(all.map((item) => item.id)).toEqual([Project.ID.make("active"), Project.ID.make("archived")])
      expect(all[1]?.time.archived).toBe(5)
    }),
  )

  it.live("archives projects whose directories are gone and unarchives them on resolve", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const kept = path.join(tmp.path, "kept")
      const removed = path.join(tmp.path, "removed")
      yield* Effect.promise(() => Promise.all([fs.mkdir(kept), fs.mkdir(removed)]))
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const keptProject = yield* project.resolve(abs(kept))
      const removedProject = yield* project.resolve(abs(removed))
      yield* project.update({ projectID: removedProject.id, name: "Removed" })
      yield* idle()
      const updated = (yield* project.list()).find((item) => item.id === removedProject.id)?.time.updated
      const updates: Project.Info[] = []
      yield* bus.subscribe(ProjectSchema.Event.Updated).pipe(
        Stream.runForEach((event) => Effect.sync(() => updates.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* Effect.promise(() => fs.rm(removed, { recursive: true }))
      yield* project.sweep()
      yield* project.sweep()
      yield* Effect.yieldNow

      expect((yield* project.list()).map((item) => item.id)).toEqual([keptProject.id])
      const archived = (yield* project.list({ archived: true })).find((item) => item.id === removedProject.id)
      expect(archived?.time.archived).toBeNumber()
      expect(archived?.time.updated).toBe(updated)
      expect(updates).toEqual([archived!])

      yield* Effect.promise(() => fs.mkdir(removed))
      yield* project.resolve(abs(removed))
      yield* project.resolve(abs(removed))
      yield* Effect.yieldNow

      const restored = (yield* project.list()).find((item) => item.id === removedProject.id)
      expect(restored).toMatchObject({ name: "Removed", time: { updated } })
      expect(restored?.time.archived).toBeUndefined()
      expect(updates).toEqual([archived!, restored!])
    }),
  )

  it.live("moves the canonical directory to a surviving clone instead of archiving", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const main = path.join(tmp.path, "repo")
      const clone = path.join(tmp.path, "clone")
      const linked = path.join(tmp.path, "linked")
      yield* Effect.promise(async () => {
        await fs.mkdir(main)
        await initRepo(main, { commit: true, remote: "git@github.com:owner/repo.git" })
        await $`git clone --no-hardlinks ${main} ${clone}`.quiet()
        await $`git remote set-url origin git@github.com:owner/repo.git`.cwd(clone).quiet()
        await $`git worktree add ${linked} -b linked`.cwd(main).quiet()
      })
      const project = yield* Project.Service
      const initial = yield* project.resolve(abs(main))
      yield* project.resolve(abs(linked))
      yield* project.resolve(abs(clone))
      yield* idle()

      yield* Effect.promise(() => fs.rm(main, { recursive: true }))
      yield* project.sweep()

      const info = (yield* project.list()).find((item) => item.id === initial.id)
      expect(info?.canonical).toBe(yield* real(clone))
      expect(info?.time.archived).toBeUndefined()
    }),
  )

  it.live("skips projects updated or active within the last sweep interval", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      const old = Date.now() - 2 * 60 * 60 * 1000
      yield* db
        .insert(ProjectTable)
        .values([
          {
            id: Project.ID.make("updated"),
            worktree: abs("/opencode-missing-updated"),
            sandboxes: [],
            time_active: old,
          },
          {
            id: Project.ID.make("active"),
            worktree: abs("/opencode-missing-active"),
            sandboxes: [],
            time_updated: old,
          },
          {
            id: Project.ID.make("idle"),
            worktree: abs("/opencode-missing-idle"),
            sandboxes: [],
            time_updated: old,
            time_active: old,
          },
        ])
        .run()

      yield* project.sweep()

      expect((yield* project.list()).map((item) => item.id).toSorted()).toEqual([
        Project.ID.make("active"),
        Project.ID.make("updated"),
      ])
    }),
  )

  it.effect("never archives the global project", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      yield* db
        .insert(ProjectTable)
        .values({
          id: Project.ID.global,
          worktree: abs("/opencode-missing-global"),
          sandboxes: [],
          time_updated: 1,
          time_active: 1,
        })
        .run()

      yield* project.sweep()

      expect((yield* project.list()).map((item) => item.id)).toEqual([Project.ID.global])
    }),
  )
})

describe("Project.delete", () => {
  const exists = (dir: string) => Effect.promise(() => fs.stat(dir).then(() => true, () => false))

  it.live("moves the directory to the trash, removes its rows, and publishes project.trashed", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const target = path.join(tmp.path, "project")
      const nested = path.join(target, "nested", "file.txt")
      yield* Effect.promise(() => fs.mkdir(path.dirname(nested), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(nested, "keep"))
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const info = yield* project.resolve(abs(target))
      const canonical = yield* real(target)
      const trashed: ProjectSchema.Trashed[] = []
      yield* bus.subscribe(ProjectSchema.Event.Trashed).pipe(
        Stream.runForEach((event) => Effect.sync(() => trashed.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )
      const deleted: Project.Info[] = []
      yield* bus.subscribe(ProjectSchema.Event.Deleted).pipe(
        Stream.runForEach((event) => Effect.sync(() => deleted.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      expect(yield* project.delete(info.id)).toMatchObject({ id: info.id, canonical })
      yield* Effect.yieldNow

      expect(yield* exists(target)).toBe(false)
      expect((yield* project.list()).map((item) => item.id)).not.toContain(info.id)
      expect(yield* project.trashList()).toEqual([{ id: info.id, directory: canonical, trashedAt: expect.any(Number) }])
      expect(trashed).toEqual([{ id: info.id, directory: canonical, trashedAt: expect.any(Number) }])
      expect(deleted).toEqual([])
    }),
  )

  it.live("restores a trashed project with its files and metadata, and publishes project.restored", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const target = path.join(tmp.path, "project")
      const nested = path.join(target, "nested", "file.txt")
      yield* Effect.promise(() => fs.mkdir(path.dirname(nested), { recursive: true }))
      yield* Effect.promise(() => fs.writeFile(nested, "keep"))
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const info = yield* project.resolve(abs(target))
      yield* project.update({ projectID: info.id, name: "Trashed name", commands: { start: "bun dev" } })
      const canonical = yield* real(target)
      const restoredEvents: Project.Info[] = []
      yield* bus.subscribe(ProjectSchema.Event.Restored).pipe(
        Stream.runForEach((event) => Effect.sync(() => restoredEvents.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* project.delete(info.id)
      expect(yield* exists(target)).toBe(false)

      const restored = yield* project.trashRestore(info.id)
      yield* Effect.yieldNow

      expect(restored).toMatchObject({ id: info.id, canonical, name: "Trashed name", commands: { start: "bun dev" } })
      expect(yield* exists(target)).toBe(true)
      expect(yield* Effect.promise(() => fs.readFile(nested, "utf8"))).toBe("keep")
      expect((yield* project.list()).map((item) => item.id)).toContain(info.id)
      expect(yield* project.trashList()).toEqual([])
      expect(restoredEvents.map((item) => item.id)).toEqual([info.id])
    }),
  )

  it.live("restores to a suffixed directory when the original path is taken again", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const target = path.join(tmp.path, "project")
      yield* Effect.promise(() => fs.mkdir(target))
      yield* Effect.promise(() => fs.writeFile(path.join(target, "original.txt"), "original"))
      const project = yield* Project.Service
      const info = yield* project.resolve(abs(target))
      const canonical = yield* real(target)

      yield* project.delete(info.id)
      yield* Effect.promise(() => fs.mkdir(target))
      yield* Effect.promise(() => fs.writeFile(path.join(target, "replacement.txt"), "replacement"))

      const restored = yield* project.trashRestore(info.id)

      expect(restored.canonical).toBe(AbsolutePath.make(`${canonical}-1`))
      expect(yield* Effect.promise(() => fs.readFile(path.join(`${canonical}-1`, "original.txt"), "utf8"))).toBe(
        "original",
      )
      expect(yield* Effect.promise(() => fs.readFile(path.join(target, "replacement.txt"), "utf8"))).toBe("replacement")
      expect(yield* project.trashList()).toEqual([])
    }),
  )

  it.live("empties the trash permanently and publishes project.deleted for each project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const first = path.join(tmp.path, "first")
      const second = path.join(tmp.path, "second")
      yield* Effect.promise(() => Promise.all([fs.mkdir(first), fs.mkdir(second)]))
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const one = yield* project.resolve(abs(first))
      const two = yield* project.resolve(abs(second))
      const deleted: Project.Info[] = []
      yield* bus.subscribe(ProjectSchema.Event.Deleted).pipe(
        Stream.runForEach((event) => Effect.sync(() => deleted.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* project.delete(one.id)
      yield* project.delete(two.id)
      expect((yield* project.trashList()).map((item) => item.id).toSorted()).toEqual([one.id, two.id].toSorted())

      expect(yield* project.trashEmpty()).toBe(2)
      yield* Effect.yieldNow

      expect(yield* project.trashList()).toEqual([])
      expect(deleted.map((item) => item.id).toSorted()).toEqual([one.id, two.id].toSorted())
    }),
  )

  it.live("restores the VCS type on the next resolve after restoring a git project", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const project = yield* Project.Service
      const info = yield* project.resolve(abs(tmp.path))
      expect(info.vcs?.type).toBe("git")

      yield* project.delete(info.id)
      const restored = yield* project.trashRestore(info.id)
      expect(restored.vcs).toBeUndefined()

      const resolved = yield* project.resolve(abs(tmp.path))
      expect(resolved.vcs?.type).toBe("git")
      expect((yield* project.list()).find((item) => item.id === info.id)?.vcs).toBe("git")
    }),
  )

  it.live("fails to restore when the trash folder was removed by hand, and empty clears the stale row", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const target = path.join(tmp.path, "project")
      yield* Effect.promise(() => fs.mkdir(target))
      const project = yield* Project.Service
      const global = yield* Global.Service
      const info = yield* project.resolve(abs(target))

      const trashDir = path.join(global.data, "trash")
      // The trash directory is shared by every test in this run: take the entry this delete adds.
      const before = yield* Effect.promise(() => fs.readdir(trashDir).catch(() => [] as string[]))
      yield* project.delete(info.id)
      const after = yield* Effect.promise(() => fs.readdir(trashDir))
      const added = after.filter((entry) => !before.includes(entry))
      expect(added).toHaveLength(1)
      yield* Effect.promise(() => fs.rm(path.join(trashDir, added[0]!), { recursive: true, force: true }))

      const error = yield* project.trashRestore(info.id).pipe(Effect.flip)
      expect(error._tag).toBe("Project.TrashMissingError")
      expect((yield* project.trashList()).map((item) => item.id)).toEqual([info.id])
      expect((yield* project.list()).map((item) => item.id)).not.toContain(info.id)

      expect(yield* project.trashEmpty()).toBe(1)
      expect(yield* project.trashList()).toEqual([])
    }),
  )

  it.live("fails with NotFoundError when restoring or emptying an unknown trash entry", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const error = yield* project.trashRestore(Project.ID.make("missing")).pipe(Effect.flip)

      expect(error._tag).toBe("Project.NotFoundError")
      expect(yield* project.trashEmpty()).toBe(0)
    }),
  )

  it.live("removes the row when the directory is already gone, publishing project.deleted and no trash entry", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const target = path.join(tmp.path, "project")
      yield* Effect.promise(() => fs.mkdir(target))
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const info = yield* project.resolve(abs(target))
      yield* Effect.promise(() => fs.rm(target, { recursive: true }))
      const deleted: Project.Info[] = []
      yield* bus.subscribe(ProjectSchema.Event.Deleted).pipe(
        Stream.runForEach((event) => Effect.sync(() => deleted.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      expect((yield* project.delete(info.id)).id).toBe(info.id)
      yield* Effect.yieldNow

      expect((yield* project.list()).map((item) => item.id)).not.toContain(info.id)
      expect(yield* project.trashList()).toEqual([])
      expect(deleted.map((item) => item.id)).toEqual([info.id])
    }),
  )

  it.live("refuses the global project and leaves its directory alone", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const target = path.join(tmp.path, "project")
      yield* Effect.promise(() => fs.mkdir(target))
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.global, worktree: abs(target), sandboxes: [], time_active: 1 })
        .run()

      const error = yield* project.delete(Project.ID.global).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "Project.DeleteRefusedError", reason: "global" })
      expect(yield* exists(target)).toBe(true)
      expect((yield* project.list()).map((item) => item.id)).toContain(Project.ID.global)
    }),
  )

  it.live("refuses the filesystem root", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      const root = path.parse(process.cwd()).root
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.make("root"), worktree: abs(root), sandboxes: [], time_active: 1 })
        .run()

      const error = yield* project.delete(Project.ID.make("root")).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "Project.DeleteRefusedError", reason: "root" })
      expect((yield* project.list()).map((item) => item.id)).toContain(Project.ID.make("root"))
    }),
  )

  it.live("refuses the home directory", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      const project = yield* Project.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: Project.ID.make("home"), worktree: abs(os.homedir()), sandboxes: [], time_active: 1 })
        .run()

      const error = yield* project.delete(Project.ID.make("home")).pipe(Effect.flip)

      expect(error).toMatchObject({ _tag: "Project.DeleteRefusedError", reason: "home" })
      expect((yield* project.list()).map((item) => item.id)).toContain(Project.ID.make("home"))
    }),
  )

  it.effect("fails with NotFoundError for an unknown project", () =>
    Effect.gen(function* () {
      const project = yield* Project.Service
      const error = yield* project.delete(Project.ID.make("missing")).pipe(Effect.flip)

      expect(error._tag).toBe("Project.NotFoundError")
    }),
  )
})

describe("Project.delete move helpers", () => {
  const errnoError = (code: string) => Object.assign(new Error(`mock ${code}`), { code })

  it.effect("retries a transient EBUSY remove until it succeeds", () =>
    Effect.gen(function* () {
      let calls = 0
      const fiber = yield* Project.removeDirectoryWithRetry(
        () => {
          calls += 1
          return calls < 3 ? Promise.reject(errnoError("EBUSY")) : Promise.resolve()
        },
        "/nope",
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* advance(() => calls >= 3)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(calls).toBe(3)
    }),
  )

  it.effect("gives up after five attempts when the remove stays locked", () =>
    Effect.gen(function* () {
      let calls = 0
      const fiber = yield* Project.removeDirectoryWithRetry(() => {
        calls += 1
        return Promise.reject(errnoError("EBUSY"))
      }, "/nope").pipe(Effect.forkChild({ startImmediately: true }))
      yield* advance(() => calls >= 5)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect((error as NodeJS.ErrnoException).code).toBe("EBUSY")
      expect(calls).toBe(5)
    }),
  )

  it.effect("does not retry a remove that fails for another reason", () =>
    Effect.gen(function* () {
      let calls = 0
      const fiber = yield* Project.removeDirectoryWithRetry(() => {
        calls += 1
        return Promise.reject(errnoError("ENOENT"))
      }, "/nope").pipe(Effect.forkChild({ startImmediately: true }))
      yield* advance(() => calls >= 1)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
      expect(calls).toBe(1)
    }),
  )

  it.effect("retries a copy that fails with ENOENT once and removes the partial destination", () =>
    Effect.gen(function* () {
      let copies = 0
      let removes = 0
      const fiber = yield* Project.copyDirectoryWithRetry(
        () => {
          copies += 1
          return copies < 2 ? Promise.reject(errnoError("ENOENT")) : Promise.resolve()
        },
        () => {
          removes += 1
          return Promise.resolve()
        },
        "/from",
        "/to",
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* advance(() => copies >= 2)
      const exit = yield* Fiber.await(fiber)

      expect(Exit.isSuccess(exit)).toBe(true)
      expect(copies).toBe(2)
      expect(removes).toBe(1)
    }),
  )

  it.effect("gives up after two attempts when the copy keeps failing", () =>
    Effect.gen(function* () {
      let copies = 0
      let removes = 0
      const fiber = yield* Project.copyDirectoryWithRetry(
        () => {
          copies += 1
          return Promise.reject(errnoError("ENOENT"))
        },
        () => {
          removes += 1
          return Promise.resolve()
        },
        "/from",
        "/to",
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* advance(() => copies >= 2)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect((error as NodeJS.ErrnoException).code).toBe("ENOENT")
      expect(copies).toBe(2)
      expect(removes).toBe(2)
    }),
  )

  it.effect("does not retry a copy that fails for another reason", () =>
    Effect.gen(function* () {
      let copies = 0
      let removes = 0
      const fiber = yield* Project.copyDirectoryWithRetry(
        () => {
          copies += 1
          return Promise.reject(errnoError("EACCES"))
        },
        () => {
          removes += 1
          return Promise.resolve()
        },
        "/from",
        "/to",
      ).pipe(Effect.forkChild({ startImmediately: true }))
      yield* advance(() => copies >= 1)
      const error = yield* Fiber.join(fiber).pipe(Effect.flip)

      expect((error as NodeJS.ErrnoException).code).toBe("EACCES")
      expect(copies).toBe(1)
      expect(removes).toBe(1)
    }),
  )

  it.effect("maps a locked copy failure to DeleteBusyError", () =>
    Effect.gen(function* () {
      const error = yield* Project.deleteMoveError(errnoError("EBUSY"), Project.ID.make("x"), abs("/x")).pipe(
        Effect.flip,
      )

      expect(error).toMatchObject({ _tag: "Project.DeleteBusyError" })
    }),
  )

  it.effect("lets any other copy failure die", () =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(Project.deleteMoveError(new Error("boom"), Project.ID.make("x"), abs("/x")))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }),
  )
})

// The copy fallback only runs when rename crosses volumes, and the leftover path only runs when the remove
// then fails: both need a project on another filesystem than the trash, and the remove failure needs POSIX
// permissions, which root bypasses and Windows does not honor the same way.
describe.skipIf(process.platform !== "linux" || !existsSync("/dev/shm") || (typeof process.getuid === "function" && process.getuid() === 0))(
  "Project.delete cross-volume fallback",
  () => {
    const exists = (dir: string) => Effect.promise(() => fs.stat(dir).then(() => true, () => false))

    it.live("moves the directory to the trash through the copy fallback when rename crosses volumes", () =>
      Effect.gen(function* () {
        const shm = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join("/dev/shm", "opencode-project-"))),
          (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true })),
        )
        const target = path.join(shm, "project")
        const nested = path.join(target, "nested", "file.txt")
        yield* Effect.promise(() => fs.mkdir(path.dirname(nested), { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(nested, "keep"))
        const project = yield* Project.Service
        const bus = yield* Bus.Service
        const info = yield* project.resolve(abs(target))
        const canonical = yield* real(target)
        const trashed: ProjectSchema.Trashed[] = []
        yield* bus.subscribe(ProjectSchema.Event.Trashed).pipe(
          Stream.runForEach((event) => Effect.sync(() => trashed.push(event.data))),
          Effect.forkScoped({ startImmediately: true }),
        )

        const result = yield* project.delete(info.id)
        yield* Effect.yieldNow

        expect(result).toMatchObject({ id: info.id, canonical })
        expect(result.leftoverDirectory).toBeUndefined()
        expect(yield* exists(target)).toBe(false)
        expect((yield* project.list()).map((item) => item.id)).not.toContain(info.id)
        expect(yield* project.trashList()).toEqual([
          { id: info.id, directory: canonical, trashedAt: expect.any(Number) },
        ])
        expect(trashed).toEqual([{ id: info.id, directory: canonical, trashedAt: expect.any(Number) }])
        // The trash copy holds the files; empty it so the shared trash dir stays clean.
        expect(yield* project.trashEmpty()).toBe(1)
      }),
    )

    it.live("keeps the trash copy and warns when the original directory cannot be removed", () =>
      Effect.gen(function* () {
        const shm = yield* Effect.acquireRelease(
          Effect.promise(() => fs.mkdtemp(path.join("/dev/shm", "opencode-project-"))),
          (dir) => Effect.promise(() => fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)),
        )
        const target = path.join(shm, "project")
        const nestedDir = path.join(target, "nested")
        const nested = path.join(nestedDir, "file.txt")
        yield* Effect.promise(() => fs.mkdir(nestedDir, { recursive: true }))
        yield* Effect.promise(() => fs.writeFile(nested, "keep"))
        const project = yield* Project.Service
        const bus = yield* Bus.Service
        const info = yield* project.resolve(abs(target))
        const canonical = yield* real(target)
        const trashed: ProjectSchema.Trashed[] = []
        yield* bus.subscribe(ProjectSchema.Event.Trashed).pipe(
          Stream.runForEach((event) => Effect.sync(() => trashed.push(event.data))),
          Effect.forkScoped({ startImmediately: true }),
        )
        // Read-only directories: the copy reads fine, but removing them fails, so the delete leaves the
        // original behind instead of throwing the good copy away.
        yield* Effect.promise(() => fs.chmod(target, 0o555))
        yield* Effect.promise(() => fs.chmod(nestedDir, 0o555))
        const result = yield* project.delete(info.id).pipe(
          Effect.ensuring(
            Effect.promise(() =>
              Promise.all([fs.chmod(target, 0o755), fs.chmod(nestedDir, 0o755)]).catch(() => undefined),
            ),
          ),
        )
        yield* Effect.yieldNow

        expect(result).toMatchObject({ id: info.id, canonical, leftoverDirectory: canonical })
        expect(yield* exists(target)).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(nested, "utf8"))).toBe("keep")
        expect((yield* project.list()).map((item) => item.id)).not.toContain(info.id)
        expect(yield* project.trashList()).toEqual([
          { id: info.id, directory: canonical, trashedAt: expect.any(Number) },
        ])
        expect(trashed).toEqual([{ id: info.id, directory: canonical, trashedAt: expect.any(Number) }])

        // The original is still there, so restoring lands on a suffixed directory with the files intact.
        const restored = yield* project.trashRestore(info.id)
        expect(restored.canonical).toBe(AbsolutePath.make(`${canonical}-1`))
        expect(
          yield* Effect.promise(() => fs.readFile(path.join(`${canonical}-1`, "nested", "file.txt"), "utf8")),
        ).toBe("keep")
        expect(yield* project.trashList()).toEqual([])
      }),
    )
  },
)

// Backdates every Project past the sweep's recent-activity window.
const idle = Effect.fn(function* () {
  const db = (yield* Database.Service).db
  yield* db.update(ProjectTable).set({ time_updated: 1, time_active: 1 }).run()
})

function remoteID(remote: string) {
  return Project.ID.make(Hash.fast(`git-remote:${remote}`))
}

function abs(value: string) {
  return AbsolutePath.make(value)
}

function real(value: string) {
  return Effect.promise(() => fs.realpath(value)).pipe(Effect.map((value) => AbsolutePath.make(value)))
}

async function initRepo(dir: string, opts?: { commit?: boolean; remote?: string }) {
  await initGit(dir)
  if (opts?.commit) await $`git commit --allow-empty -m root`.cwd(dir).quiet()
  if (opts?.remote) await $`git remote add origin ${opts.remote}`.cwd(dir).quiet()
}

async function rootCommit(dir: string) {
  return (await $`git rev-list --max-parents=0 HEAD`.cwd(dir).text()).trim()
}

describe("Project.resolve", () => {
  it.live("creates distinct deterministic projects for exact markerless directories", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const project = yield* Project.Service
      const nested = path.join(tmp.path, "notes", "drafts")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))

      const result = yield* project.resolve(abs(tmp.path))
      const repeated = yield* project.resolve(abs(`${tmp.path}${path.sep}.`))
      const child = yield* project.resolve(abs(nested))

      expect(result.id).not.toBe(Project.ID.global)
      expect(repeated.id).toBe(result.id)
      expect(child.id).not.toBe(result.id)
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(child.directory).toBe(yield* real(nested))
      expect(result.canonical).toBe(result.directory)
      expect(result.previous).toBeUndefined()
      expect(result.vcs).toBeUndefined()
    }),
  )

  it.live("repository markers override markerless directory projects", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const nested = path.join(tmp.path, "packages", "app")
      yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
      const project = yield* Project.Service
      const root = yield* project.resolve(abs(tmp.path))
      const child = yield* project.resolve(abs(nested))

      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const repository = yield* project.resolve(abs(nested))

      expect(root.id).not.toBe(child.id)
      expect(repository.id).not.toBe(root.id)
      expect(repository.id).not.toBe(child.id)
      expect(repository.directory).toBe(yield* real(tmp.path))
      expect(repository.vcs?.type).toBe("git")
    }),
  )

  it.live("does not publish project updates for first or repeated resolutions", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const updates: Project.Info[] = []
      yield* bus.subscribe(ProjectSchema.Event.Updated).pipe(
        Stream.runForEach((event) => Effect.sync(() => updates.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* project.resolve(abs(tmp.path))
      yield* project.resolve(abs(tmp.path))
      yield* Effect.yieldNow

      expect(updates).toEqual([])
    }),
  )

  it.live("publishes preserved project metadata when its canonical directory is renamed", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const before = path.join(tmp.path, "before")
      const after = path.join(tmp.path, "after")
      yield* Effect.promise(() => fs.mkdir(before))
      yield* Effect.promise(() => initRepo(before, { commit: true, remote: "git@github.com:owner/repo.git" }))
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const initial = yield* project.resolve(abs(before))
      yield* project.update({ projectID: initial.id, name: "Preserved name" })
      const updates: Project.Info[] = []
      yield* bus.subscribe(ProjectSchema.Event.Updated).pipe(
        Stream.runForEach((event) => Effect.sync(() => updates.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* Effect.promise(() => fs.rename(before, after))
      const renamed = yield* project.resolve(abs(after))
      yield* Effect.yieldNow

      expect(renamed.id).toBe(initial.id)
      expect(renamed.canonical).toBe(yield* real(after))
      expect(updates).toHaveLength(1)
      expect(updates).toEqual((yield* project.list()).filter((item) => item.id === initial.id))
      expect(updates[0]).toMatchObject({
        id: initial.id,
        canonical: yield* real(after),
        name: "Preserved name",
      })
    }),
  )

  it.live("keeps the canonical project directory when opening another clone", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const main = path.join(tmp.path, "repo")
      const clone = path.join(tmp.path, "other-clone")
      const linked = path.join(tmp.path, "linked")
      yield* Effect.promise(async () => {
        await fs.mkdir(main)
        await initRepo(main, { commit: true, remote: "git@github.com:owner/repo.git" })
        await $`git clone --no-hardlinks ${main} ${clone}`.quiet()
        await $`git remote set-url origin https://github.com/owner/repo.git`.cwd(clone).quiet()
        await $`git worktree add ${linked} -b linked`.cwd(main).quiet()
      })
      const project = yield* Project.Service
      const bus = yield* Bus.Service
      const initial = yield* project.resolve(abs(main))
      const updates: Project.Info[] = []
      yield* bus.subscribe(ProjectSchema.Event.Updated).pipe(
        Stream.runForEach((event) => Effect.sync(() => updates.push(event.data))),
        Effect.forkScoped({ startImmediately: true }),
      )

      for (const directory of [clone, linked, main, clone]) {
        const resolved = yield* project.resolve(abs(directory))
        expect(resolved.id).toBe(initial.id)
        expect(resolved.directory).toBe(abs(directory))
        expect(resolved.canonical).toBe(abs(directory === clone ? clone : main))
        expect((yield* project.list()).find((item) => item.id === initial.id)?.canonical).toBe(abs(main))
      }
      yield* Effect.yieldNow

      expect(updates).toEqual([])
    }),
  )

  it.live("returns git global for repo with no commits and no remote", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path))
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(Project.ID.make("global"))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.canonical).toBe(result.directory)
      expect(result.previous).toBeUndefined()
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("falls back to root commit when origin is missing", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(Project.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.canonical).toBe(result.directory)
      expect(result.previous).toBeUndefined()
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("prefers normalized origin over root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:Acme/App.git" }))
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(remoteID("github.com/Acme/App"))
      expect(result.id).not.toBe(Project.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
      expect(result.directory).toBe(yield* real(tmp.path))
      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("normalizes ssh and https remotes to the same id", () =>
    Effect.gen(function* () {
      const ssh = yield* tmpdirScoped()
      const https = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(ssh.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => initRepo(https.path, { commit: true, remote: "https://github.com/owner/repo.git" }))
      const project = yield* Project.Service

      const a = yield* project.resolve(abs(ssh.path))
      const b = yield* project.resolve(abs(https.path))

      expect(a.id).toBe(remoteID("github.com/owner/repo"))
      expect(b.id).toBe(a.id)
    }),
  )

  it.live("ignores file remotes and falls back to root commit", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: `file://${tmp.path}` }))
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.id).toBe(Project.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))))
    }),
  )

  it.live("returns previous cached id from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.previous).toBe(Project.ID.make("old-id"))
      expect(result.id).toBe(remoteID("github.com/owner/repo"))
    }),
  )

  it.live("does not write the cache while resolving", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      const project = yield* Project.Service

      yield* project.resolve(abs(tmp.path))

      expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, ".git", "opencode")).exists())).toBe(false)
    }),
  )

  it.live("resolves from nested directories to repo root", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, "a", "b"), { recursive: true }))
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(path.join(tmp.path, "a", "b")))

      expect(result.directory).toBe(yield* real(tmp.path))
    }),
  )

  it.live("prefers git when both git and mercurial metadata exist", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true }))
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".hg")))
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.vcs?.type).toBe("git")
    }),
  )

  it.live("prefers the nearest mercurial marker over an outer git repository", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const nested = path.join(tmp.path, "nested")
      yield* Effect.promise(async () => {
        await initRepo(tmp.path, { commit: true })
        await fs.mkdir(path.join(nested, ".hg"), { recursive: true })
        await fs.mkdir(path.join(nested, "app"))
      })
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(path.join(nested, "app")))

      expect(result.vcs?.type).toBe("hg")
      expect(result.directory).toBe(yield* real(nested))
    }),
  )

  it.live("prefers the nearest git marker over an outer mercurial repository", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const nested = path.join(tmp.path, "nested")
      yield* Effect.promise(async () => {
        await fs.mkdir(path.join(tmp.path, ".hg"))
        await fs.mkdir(path.join(nested, "app"), { recursive: true })
        await initRepo(nested, { commit: true })
      })
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(path.join(nested, "app")))

      expect(result.vcs?.type).toBe("git")
      expect(result.directory).toBe(yield* real(nested))
    }),
  )

  it.live("returns global id for unreadable mercurial metadata", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => fs.mkdir(path.join(tmp.path, ".hg")))
      const project = yield* Project.Service

      const result = yield* project.resolve(abs(tmp.path))

      expect(result.vcs?.type).toBe("hg")
      expect(result.id).toBe(Project.ID.make("global"))
    }),
  )

  it.live("linked worktree returns opened worktree directory and previous from common dir", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const worktree = `${tmp.path}-worktree`
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => $`rm -rf ${worktree}`.quiet().nothrow()).pipe(Effect.ignore),
      )
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      yield* Effect.promise(() => Bun.write(path.join(tmp.path, ".git", "opencode"), "old-id"))
      yield* Effect.promise(() => $`git worktree add ${worktree} -b test-${Date.now()}`.cwd(tmp.path).quiet())
      const project = yield* Project.Service
      const db = (yield* Database.Service).db
      const id = remoteID("github.com/owner/repo")
      yield* db
        .insert(ProjectTable)
        .values({
          id,
          worktree: abs("/stale-worktree"),
          vcs: "hg",
          name: "Preserved name",
          icon_color: "#123456",
          commands: { start: "bun dev" },
          sandboxes: [abs("/preserved-sandbox")],
          time_created: 1,
          time_updated: 1,
          time_initialized: 2,
        })
        .run()

      const result = yield* project.resolve(abs(worktree))

      expect(result.directory).toBe(yield* real(worktree))
      expect(result.canonical).toBe(yield* real(tmp.path))
      expect(result.previous).toBe(Project.ID.make("old-id"))
      expect(result.id).toBe(id)
      expect(result.vcs?.type).toBe("git")
      expect((yield* project.list()).find((item) => item.id === id)).toMatchObject({
        canonical: yield* real(tmp.path),
        vcs: "git",
        name: "Preserved name",
        icon: { color: "#123456" },
        commands: { start: "bun dev" },
        sandboxes: [abs("/preserved-sandbox")],
        time: { created: 1 },
      })
    }),
  )

  const counted = (fail?: (args: readonly string[]) => boolean) => {
    const counter = countingSpawner(fail)
    return {
      spawns: counter.spawns,
      layer: AppNodeBuilder.build(LayerNode.group([Project.node, Database.node, Bus.node]), [counter.node]),
    }
  }

  testEffect(Layer.empty).live("reuses git discovery until git metadata changes", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const nested = path.join(tmp.path, "packages", "app")
      yield* Effect.promise(async () => {
        await initRepo(tmp.path, { commit: true })
        await fs.mkdir(nested, { recursive: true })
      })
      const rootSha = Project.ID.make(yield* Effect.promise(() => rootCommit(tmp.path)))
      const { layer, spawns } = counted()
      yield* Effect.gen(function* () {
        const project = yield* Project.Service
        expect((yield* project.resolve(abs(nested))).id).toBe(rootSha)
        expect(spawns()).toBeGreaterThan(0)

        const before = spawns()
        expect((yield* project.resolve(abs(nested))).id).toBe(rootSha)
        expect((yield* project.resolve(abs(tmp.path))).id).toBe(rootSha)
        expect(spawns()).toBe(before)

        yield* Effect.promise(() => $`git remote add origin git@github.com:owner/repo.git`.cwd(tmp.path).quiet())
        expect((yield* project.resolve(abs(nested))).id).toBe(remoteID("github.com/owner/repo"))
        expect(spawns()).toBeGreaterThan(before)
      }).pipe(Effect.provide(layer))
    }),
  )

  testEffect(Layer.empty).live("does not cache a transient git failure", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      yield* Effect.promise(() => initRepo(tmp.path, { commit: true, remote: "git@github.com:owner/repo.git" }))
      let failRemote = true
      const { layer } = counted((args) => {
        if (!failRemote || !args.includes("remote")) return false
        failRemote = false
        return true
      })
      yield* Effect.gen(function* () {
        const project = yield* Project.Service
        // Falls back like dev: the remote spawn failed, so identity comes from the root commit.
        expect((yield* project.resolve(abs(tmp.path))).id).toBe(
          Project.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))),
        )
        expect((yield* project.resolve(abs(tmp.path))).id).toBe(remoteID("github.com/owner/repo"))
      }).pipe(Effect.provide(layer))
    }),
  )

  testEffect(Layer.empty).live("sees the first commit in a reftable repository", () =>
    Effect.gen(function* () {
      const tmp = yield* tmpdirScoped()
      const supported = yield* Effect.promise(
        async () => (await $`git init -q --ref-format=reftable ${tmp.path}`.nothrow().quiet()).exitCode === 0,
      )
      if (!supported) return
      yield* Effect.gen(function* () {
        const project = yield* Project.Service
        expect((yield* project.resolve(abs(tmp.path))).id).toBe(Project.ID.global)
        yield* Effect.promise(() =>
          $`git -c user.name=Test -c user.email=test@opencode.test -c commit.gpgsign=false commit --allow-empty -qm root`
            .cwd(tmp.path)
            .quiet(),
        )
        expect((yield* project.resolve(abs(tmp.path))).id).toBe(
          Project.ID.make(yield* Effect.promise(() => rootCommit(tmp.path))),
        )
      }).pipe(Effect.provide(counted().layer))
    }),
  )
})
