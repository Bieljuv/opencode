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
const SessionResponse = Schema.Struct({ data: Session.Info })

it.live("deletes the project, its sessions, and its directory from disk", () =>
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
    expect(deleted.status).toBe(204)

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
