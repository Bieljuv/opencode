import { FileSystem } from "@opencode/core/filesystem"
import { FileWatch } from "@opencode/core/filesystem/file-watch"
import { Location } from "@opencode/core/location"
import { createZip, type ZipEntry } from "@opencode/core/publish/zip"
import { RelativePath } from "@opencode/core/schema"
import { FileNotFoundError, ServiceUnavailableError } from "@opencode/protocol/errors"
import { Effect, Option, Stream, type PlatformError } from "effect"
import { type HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import path from "path"
import { Api } from "../api"
import { ContentHeaders } from "../content-headers"
import { response } from "../location"

export const FileSystemHandler = HttpApiBuilder.group(Api, "server.fs", (handlers) =>
  Effect.gen(function* () {
    const fileWatch = yield* FileWatch.Service
    return handlers
      .handleRaw("fs.read", (ctx) =>
        Effect.gen(function* () {
          const path = yield* decodeRequestPath(ctx.request.url)
          const fs = yield* FileSystem.Service
          const file = yield* fs
            .read({ path })
            .pipe(
              Effect.mapError(
                (error) => new FileNotFoundError({ path: error.path, message: `File not found: ${error.path}` }),
              ),
            )
          return serveFile(ctx.request, file, ContentHeaders.download({ path, mime: file.mime }))
        }),
      )
      .handle("fs.list", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs
              .list(ctx.query)
              .pipe(
                Effect.mapError(
                  (error) => new FileNotFoundError({ path: error.path, message: `Directory not found: ${error.path}` }),
                ),
              )
          }),
        ),
      )
      .handle("fs.find", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.find(ctx.query)
          }),
        ),
      )
      .handle("fs.write", (ctx) =>
        response(
          Effect.gen(function* () {
            const fs = yield* FileSystem.Service
            return yield* fs.write({ path: ctx.query.path, data: ctx.payload })
          }),
        ),
      )
      .handle("fs.watch", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const location = yield* Location.Service
          // Same confinement as read: the file must exist inside the location.
          yield* fs
            .read({ path: RelativePath.make(ctx.payload.path) })
            .pipe(
              Effect.mapError(
                (error) => new FileNotFoundError({ path: error.path, message: `File not found: ${error.path}` }),
              ),
            )
          yield* fileWatch
            .watch({
              location: { directory: location.directory, workspaceID: location.workspaceID },
              file: path.resolve(location.directory, ctx.payload.path),
            })
            .pipe(
              Effect.mapError(
                (error) => new ServiceUnavailableError({ message: error.message, service: "filewatcher" }),
              ),
            )
        }),
      )
      .handle("fs.unwatch", (ctx) =>
        Effect.gen(function* () {
          const location = yield* Location.Service
          yield* fileWatch.unwatch({
            location: { directory: location.directory, workspaceID: location.workspaceID },
            file: path.resolve(location.directory, ctx.payload.path),
          })
        }),
      )
      .handleRaw("fs.downloadProject", (ctx) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const location = yield* Location.Service
          const entries = yield* collectProjectFiles(fs).pipe(
            Effect.mapError(
              (error) => new FileNotFoundError({ path: location.directory, message: error.message }),
            ),
          )
          const name = `${path.basename(location.directory) || "projeto"}.zip`
          return HttpServerResponse.uint8Array(createZip(entries), {
            status: 200,
            contentType: "application/zip",
            headers: ContentHeaders.download({ path: name, mime: "application/zip" }),
          })
        }),
      )
  }),
)

/**
 * ManosTech: the project download (publish step 1). Walks the location and
 * zips the source files, leaving out what must never travel with the
 * project: version control, installed dependencies, build output, and secret
 * files (`.env` stays out; `.env.example` stays in). Files over 25 MB are
 * skipped and logged instead of failing the whole download.
 */
const DOWNLOAD_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "out",
  "coverage",
  ".turbo",
  "target",
  "__pycache__",
])

const DOWNLOAD_MAX_FILE_BYTES = 25 * 1024 * 1024

function collectProjectFiles(
  fs: FileSystem.Interface,
): Effect.Effect<ZipEntry[], FileSystem.NotFoundError | PlatformError.PlatformError> {
  const walk = (
    dir: string | undefined,
  ): Effect.Effect<ZipEntry[], FileSystem.NotFoundError | PlatformError.PlatformError> =>
    Effect.gen(function* () {
      const listed = yield* fs.list(dir === undefined ? undefined : { path: dir })
      const entries: ZipEntry[] = []
      for (const entry of listed) {
        const first = entry.path.split("/")[0] ?? ""
        if (entry.type === "directory") {
          if (dir === undefined && DOWNLOAD_EXCLUDED_DIRS.has(first)) continue
          entries.push(...(yield* walk(entry.path)))
          continue
        }
        const base = entry.path.split("/").pop() ?? ""
        if (base === ".env" || base.endsWith(".pem") || base.endsWith(".key")) continue
        const file = yield* fs.read({ path: entry.path })
        if (file.size > DOWNLOAD_MAX_FILE_BYTES) {
          yield* Effect.logWarning("project download skipped an oversized file", { path: entry.path })
          continue
        }
        const chunks = yield* file.stream().pipe(Stream.runCollect)
        entries.push({ path: entry.path, content: concatChunks(chunks) })
      }
      return entries
    })
  return walk(undefined)
}

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function decodeRequestPath(url: string) {
  const raw = new URL(url, "http://localhost").pathname.slice(13)
  return Effect.try({
    try: () => RelativePath.make(decodeURIComponent(raw)),
    catch: () => new FileNotFoundError({ path: raw, message: `File not found: ${raw}` }),
  })
}

function serveFile(
  request: HttpServerRequest.HttpServerRequest,
  file: FileSystem.File,
  content: ReturnType<typeof ContentHeaders.download>,
) {
  const etag = `W/"${file.size.toString(16)}-${Option.match(file.mtime, {
    onNone: () => "0",
    onSome: (mtime) => mtime.getTime().toString(16),
  })}"`
  const lastModified = Option.getOrUndefined(Option.map(file.mtime, (mtime) => mtime.toUTCString()))
  // Clients must revalidate after agent edits; no-transform keeps compression from changing Content-Length.
  const validators = {
    "cache-control": "no-cache, no-transform",
    etag,
    ...(lastModified === undefined ? {} : { "last-modified": lastModified }),
  }
  if (isNotModified(request, etag, lastModified))
    return HttpServerResponse.empty({ status: 304, headers: { ...validators, ...content } })

  const rangeHeader = request.method === "GET" ? request.headers["range"] : undefined
  const range =
    rangeHeader !== undefined && matchesIfRange(request.headers["if-range"], etag, lastModified)
      ? parseRange(rangeHeader, file.size)
      : undefined
  if (range === "unsatisfiable")
    return HttpServerResponse.empty({
      status: 416,
      headers: { "accept-ranges": "bytes", "content-range": `bytes */${file.size}` },
    })

  const offset = range?.start ?? 0
  const length = range === undefined ? file.size : range.end - range.start + 1
  return HttpServerResponse.stream(length === 0 ? Stream.empty : file.stream({ offset, bytesToRead: length }), {
    status: range === undefined ? 200 : 206,
    contentLength: length,
    headers: {
      ...validators,
      ...content,
      "accept-ranges": "bytes",
      ...(range === undefined ? {} : { "content-range": `bytes ${range.start}-${range.end}/${file.size}` }),
    },
  })
}

function isNotModified(request: HttpServerRequest.HttpServerRequest, etag: string, lastModified: string | undefined) {
  const ifNoneMatch = request.headers["if-none-match"]
  if (ifNoneMatch !== undefined)
    return ifNoneMatch.split(",").some((tag) => tag.trim() === "*" || stripWeak(tag) === stripWeak(etag))
  const ifModifiedSince = request.headers["if-modified-since"]
  return (
    ifModifiedSince !== undefined &&
    lastModified !== undefined &&
    Date.parse(lastModified) <= Date.parse(ifModifiedSince)
  )
}

function matchesIfRange(ifRange: string | undefined, etag: string, lastModified: string | undefined) {
  if (ifRange === undefined) return true
  if (/^\s*(w\/)?"/i.test(ifRange)) return stripWeak(ifRange) === stripWeak(etag)
  return lastModified !== undefined && Date.parse(ifRange) === Date.parse(lastModified)
}

function stripWeak(etag: string) {
  return etag.trim().replace(/^w\//i, "")
}

function parseRange(header: string, size: number) {
  const match = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header.trim())
  if (match === null || (match[1] === "" && match[2] === "")) return undefined
  if (match[1] === "") {
    const suffix = Number(match[2])
    if (suffix === 0 || size === 0) return "unsatisfiable"
    return { start: Math.max(size - suffix, 0), end: size - 1 }
  }
  const start = Number(match[1])
  const end = match[2] === "" ? size - 1 : Number(match[2])
  if (start > end || start >= size) return "unsatisfiable"
  return { start, end: Math.min(end, size - 1) }
}
