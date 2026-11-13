import { expect } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const options = {
  app: { version: "test-version" },
  database: { path: ":memory:" },
  config: { project: false },
  models: { fetch: false },
  fs: { filewatcher: false },
} as const

const ProjectsResponse = Schema.Array(Project.Info)
const TrashResponse = Schema.Array(Project.Trashed)
const SessionResponse = Schema.Struct({ data: Session.Info })

it.live("moves the project to the trash and its sessions away, and restores it back", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-project-delete-")))
    const directory = path.join(config.path, "project")
    yield* Effect.promise(() => fs.mkdir(directory))
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })
    const request = (endpoint: string, method: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${endpoint}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )
    const created = yield* request("/api/session", "POST", { location: { directory } })
    expect(created.status).toBe(200)
    const session = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => created.json())).data

    const listed = yield* request("/api/project", "GET")
    expect(listed.status).toBe(200)
    const projects = Schema.decodeUnknownSync(ProjectsResponse)(yield* Effect.promise(() => listed.json()))
    const canonical = yield* Effect.promise(() => fs.realpath(directory))
    const info = projects.find((item) => item.canonical === canonical)
    expect(info).toBeDefined()

    const deleted = yield* request(`/api/project/${info!.id}`, "DELETE")
    expect(deleted.status).toBe(200)
    expect(Schema.decodeUnknownSync(Project.DeleteResult)(yield* Effect.promise(() => deleted.json()))).toEqual({})

    const exists = yield* Effect.promise(() => fs.stat(directory).then(() => true, () => false))
    expect(exists).toBe(false)
    const gone = yield* request(`/api/session/${session.id}`, "GET")
    expect(gone.status).toBe(404)
    expect(((yield* Effect.promise(() => gone.json())) as { _tag: string })._tag).toBe("SessionNotFoundError")
    const remainingResponse = yield* request("/api/project", "GET")
    const remaining = Schema.decodeUnknownSync(ProjectsResponse)(
      yield* Effect.promise(() => remainingResponse.json()),
    )
    expect(remaining.map((item) => item.id)).not.toContain(info!.id)

    const trashedResponse = yield* request("/api/project/trash", "GET")
    expect(trashedResponse.status).toBe(200)
    const trashed = Schema.decodeUnknownSync(TrashResponse)(yield* Effect.promise(() => trashedResponse.json()))
    expect(trashed.map((item) => item.id)).toEqual([info!.id])
    expect(`${trashed[0]?.directory}`).toBe(canonical)

    const restoredResponse = yield* request(`/api/project/trash/${info!.id}/restore`, "POST")
    expect(restoredResponse.status).toBe(200)
    const restored = Schema.decodeUnknownSync(Project.Info)(yield* Effect.promise(() => restoredResponse.json()))
    expect(restored).toMatchObject({ id: info!.id, canonical })

    expect(yield* Effect.promise(() => fs.stat(directory).then(() => true, () => false))).toBe(true)
    const backResponse = yield* request("/api/project", "GET")
    const back = Schema.decodeUnknownSync(ProjectsResponse)(yield* Effect.promise(() => backResponse.json()))
    expect(back.map((item) => item.id)).toContain(info!.id)
    const emptyTrashResponse = yield* request("/api/project/trash", "GET")
    const emptyTrash = Schema.decodeUnknownSync(TrashResponse)(yield* Effect.promise(() => emptyTrashResponse.json()))
    expect(emptyTrash).toEqual([])
  }),
)

it.live("empties the trash permanently", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-project-delete-")))
    const first = path.join(config.path, "first")
    const second = path.join(config.path, "second")
    yield* Effect.promise(() => Promise.all([fs.mkdir(first), fs.mkdir(second)]))
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })
    const request = (endpoint: string, method: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${endpoint}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )
    for (const directory of [first, second]) {
      const created = yield* request("/api/session", "POST", { location: { directory } })
      expect(created.status).toBe(200)
    }
    const listed = yield* request("/api/project", "GET")
    const projects = Schema.decodeUnknownSync(ProjectsResponse)(yield* Effect.promise(() => listed.json()))
    expect(projects).toHaveLength(2)

    for (const item of projects) {
      const deleted = yield* request(`/api/project/${item.id}`, "DELETE")
      expect(deleted.status).toBe(200)
      expect(Schema.decodeUnknownSync(Project.DeleteResult)(yield* Effect.promise(() => deleted.json()))).toEqual({})
    }
    const trashedResponse = yield* request("/api/project/trash", "GET")
    const trashed = Schema.decodeUnknownSync(TrashResponse)(yield* Effect.promise(() => trashedResponse.json()))
    expect(trashed).toHaveLength(2)

    const emptied = yield* request("/api/project/trash", "DELETE")
    expect(emptied.status).toBe(204)

    const afterResponse = yield* request("/api/project/trash", "GET")
    const after = Schema.decodeUnknownSync(TrashResponse)(yield* Effect.promise(() => afterResponse.json()))
    expect(after).toEqual([])
    for (const directory of [first, second]) {
      expect(yield* Effect.promise(() => fs.stat(directory).then(() => true, () => false))).toBe(false)
    }
  }),
)

it.live("returns 404 when restoring an unknown trashed project, and 204 when emptying an empty trash", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-project-delete-")))
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })
    const request = (endpoint: string, method: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${endpoint}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )

    const missing = yield* request("/api/project/trash/prj_missing/restore", "POST")
    expect(missing.status).toBe(404)
    expect(((yield* Effect.promise(() => missing.json())) as { _tag: string })._tag).toBe("ProjectNotFoundError")

    const emptied = yield* request("/api/project/trash", "DELETE")
    expect(emptied.status).toBe(204)
  }),
)

it.live("returns 404 for an unknown project", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-project-delete-")))
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://opencode.local/api/project/prj_missing", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
        }),
      ),
    )
    expect(response.status).toBe(404)
    expect(((yield* Effect.promise(() => response.json())) as { _tag: string })._tag).toBe("ProjectNotFoundError")
  }),
)

it.live("refuses a home-directory project before removing any session", () =>
  Effect.gen(function* () {
    const config = yield* Effect.acquireDisposable(Effect.promise(() => tmpdir("opencode-project-delete-")))
    const home = os.homedir()
    const handler = yield* ServerFetch.make({ ...options, config: { directory: config.path } })
    const request = (endpoint: string, method: string, body?: unknown) =>
      Effect.promise(() =>
        handler(
          new Request(`http://opencode.local${endpoint}`, {
            method,
            headers: { "content-type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
          }),
        ),
      )
    const created = yield* request("/api/session", "POST", { location: { directory: home } })
    expect(created.status).toBe(200)
    const session = Schema.decodeUnknownSync(SessionResponse)(yield* Effect.promise(() => created.json())).data
    const listed = yield* request("/api/project", "GET")
    const projects = Schema.decodeUnknownSync(ProjectsResponse)(yield* Effect.promise(() => listed.json()))
    const canonical = yield* Effect.promise(() => fs.realpath(home))
    const info = projects.find((item) => item.canonical === canonical)
    expect(info).toBeDefined()

    const refused = yield* request(`/api/project/${info!.id}`, "DELETE")
    expect(refused.status).toBe(400)
    expect(((yield* Effect.promise(() => refused.json())) as { _tag: string })._tag).toBe("InvalidRequestError")

    // The refusal happens before any session is removed, so the session survives and the directory is untouched.
    const kept = yield* request(`/api/session/${session.id}`, "GET")
    expect(kept.status).toBe(200)
    expect(yield* Effect.promise(() => fs.stat(home).then(() => true, () => false))).toBe(true)
  }),
)
