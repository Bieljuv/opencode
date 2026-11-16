export * as PreviewTool from "./preview.js"

import { ToolFailure } from "@opencode/ai/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Schema } from "effect"
import path from "path"
import { Location } from "../../location.js"

export const name = "preview"

export const Input = Schema.Struct({
  path: Schema.optionalKey(Schema.String).annotate({
    description:
      "The entry HTML file to open in the preview panel, relative to the project directory (for example public/index.html). Omit it to open the project's entry file.",
  }),
})

export const Output = Schema.Struct({
  path: Schema.String,
})

export const description = [
  "Open the project's preview panel beside the chat with its entry HTML page.",
  "Call it when the user asks to open or show the preview of the project, and when you start building or changing a visual surface, so the panel opens as the work begins and keeps updating live.",
  "Pass the entry HTML file when you know it (for example public/index.html); omit it to open the project's entry file.",
  "Never offer a preview link or an artifact instead, and never say the preview is unavailable: this app previews local pages in the panel beside the chat.",
].join("\n")

/** The entry files a project opens when the agent does not name one, in order. */
const ENTRY_CANDIDATES = ["index.html", "public/index.html"]

// A file:// URI keeps its path intact: file:///tmp/x stays /tmp/x and
// file:///D:/x becomes D:/x, so the result is still an absolute path.
const stripFileScheme = (value: string) => {
  if (!value.startsWith("file://")) return value
  return value.slice("file://".length).replace(/^\/([A-Za-z]:)/, "$1")
}

export const Plugin = {
  id: "opencode.tool.preview",
  effect: Effect.fn("PreviewTool.Plugin")(function* (ctx: Context) {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service

    yield* ctx.tool
      .transform((editor) =>
        editor.add({
          name,
          options: { codemode: false },
          description,
          input: Input,
          output: Output,
          execute: (input) =>
            Effect.gen(function* () {
              const given = input.path === undefined ? undefined : stripFileScheme(input.path)
              const candidates = given === undefined ? ENTRY_CANDIDATES : [given]
              for (const candidate of candidates) {
                const absolute = path.isAbsolute(candidate)
                  ? candidate
                  : path.resolve(location.directory, candidate)
                if (!(yield* fs.isFile(absolute))) continue
                const relative = path.relative(location.directory, absolute)
                const href = relative.startsWith("..") ? absolute : relative.split(path.sep).join("/")
                return {
                  output: { path: href },
                  content: `Opened preview for ${href}.`,
                  metadata: { path: href },
                }
              }
              return yield* new ToolFailure({
                message:
                  given === undefined
                    ? "No entry file found: the project has no index.html or public/index.html. Tell the user and ask which page to open instead of inventing one."
                    : `Entry file not found: ${given}. Tell the user and ask which page to open instead of inventing one.`,
              })
            }),
        }),
      )
      .pipe(Effect.orDie)
  }),
}
