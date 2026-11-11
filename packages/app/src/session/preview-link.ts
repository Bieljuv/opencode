import type { SessionMessageInfo } from "@opencode/client/promise"

/**
 * The preview of a system the agent built: the entry HTML file its message
 * links, which the review panel opens beside the chat by itself.
 */
export type BuildPreview = {
  readonly href: string
  readonly messageID: string
}

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

/**
 * The preview the latest Build message links, if any. Only a Build turn
 * opens a preview: a question, a Plan turn or any other agent never does,
 * and tool calls are not text. Only a finished message counts — while it
 * streams, the files it names may not exist yet.
 */
export function latestBuildPreview(messages: readonly SessionMessageInfo[]): BuildPreview | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]

    if (message.type !== "assistant" || message.agent !== "build") continue
    if (message.time.completed === undefined) continue

    const href = findPreviewHref(
      message.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n"),
    )

    if (href) return { href, messageID: message.id }
  }

  return undefined
}
