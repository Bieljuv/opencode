import type { SessionMessageInfo } from "@opencode/client/promise"
import { Option, Schema } from "effect"

/**
 * The preview of a system the agent built: the entry HTML file its message
 * links or just wrote, which the review panel opens beside the chat by itself.
 */
export type BuildPreview = {
  readonly href: string
  readonly messageID: string
}

const decodeString = Schema.decodeUnknownOption(Schema.String)

// A Markdown link: [label](href). The leading `!` marks an image, never a
// preview. A scheme, a protocol-relative `//`, a query or a fragment marks a
// URL, never a file on disk.
const LINK = /(!?)\[[^\]]*\]\(([^)\s]+)\)/g

const SCHEME = /^[a-z][a-z0-9+.-]*:/i

const DRIVE = /^[a-z]:[\\/]/i

function isLocalHtmlFile(href: string): boolean {
  if (href.includes("?") || href.includes("#") || href.startsWith("//")) return false

  if (SCHEME.test(href) && !DRIVE.test(href)) return false

  return href.toLowerCase().endsWith(".html")
}

/**
 * The first local HTML file a message links, preferring the entry file.
 * Images, URLs and non-HTML files never open a preview.
 */
export function findPreviewHref(text: string): string | undefined {
  let first: string | undefined

  for (const match of text.matchAll(LINK)) {
    if (match[1] === "!") continue

    const href = match[2]

    if (!isLocalHtmlFile(href)) continue

    if ((href.split(/[\\/]/).at(-1) ?? href).toLowerCase() === "index.html") return href

    first ??= href
  }

  return first
}

// The local HTML file a finished write or edit just created, preferring the
// entry file: a Build turn that wrote the entry file and then a page keeps
// the preview on the entry file, while a turn that only touched a page
// previews that page.
function findWrittenHtml(message: SessionMessageInfo): string | undefined {
  if (message.type !== "assistant") return undefined

  let first: string | undefined

  for (const part of [...message.content].reverse()) {
    if (part.type !== "tool" || (part.name !== "write" && part.name !== "edit")) continue

    if (part.state.status !== "completed") continue

    const path = Option.getOrUndefined(decodeString(part.state.input.path))

    if (path === undefined || !isLocalHtmlFile(path)) continue

    if ((path.split(/[\\/]/).at(-1) ?? path).toLowerCase() === "index.html") return path

    first ??= path
  }

  return first
}

/**
 * The preview the latest Build message links or just wrote, if any. Only a
 * Build turn opens a preview: a question, a Plan turn or any other agent
 * never does. A finished message's link is the entry point it chose; while
 * it streams, a finished write or edit of a local HTML file is the entry
 * point instead, so the preview opens as soon as the file exists. A write
 * still streaming or running does not count — the file may not exist yet.
 */
export function latestBuildPreview(messages: readonly SessionMessageInfo[]): BuildPreview | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]

    if (message.type !== "assistant" || message.agent !== "build") continue

    if (message.time.completed !== undefined) {
      const href = findPreviewHref(
        message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
      )

      if (href) return { href, messageID: message.id }
    }

    const written = findWrittenHtml(message)

    if (written) return { href: written, messageID: message.id }
  }

  return undefined
}
