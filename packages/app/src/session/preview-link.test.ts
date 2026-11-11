import { describe, expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client/promise"
import { findPreviewHref, latestBuildPreview } from "./preview-link"

const assistant = (
  id: string,
  agent: string,
  text: string,
  completed = true,
): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: agent as "build",
  model: { id: "model", providerID: "provider" },
  content: [{ type: "text", text }],
  time: { created: 1, completed: completed ? 2 : undefined },
})

const user = (id: string): SessionMessageInfo => ({
  id,
  type: "user",
  text: "crie um sistema",
  time: { created: 1 },
})

describe("findPreviewHref", () => {
  test("prefers the entry file over other HTML links", () => {
    expect(findPreviewHref("Veja [sobre](sobre.html) e [a entrada](index.html)")).toBe("index.html")
  })

  test("takes the first HTML link when there is no entry file", () => {
    expect(findPreviewHref("Veja [a loja](loja.html)")).toBe("loja.html")
  })

  test("keeps a nested entry path", () => {
    expect(findPreviewHref("Abrindo [o PDV](pdv/index.html)")).toBe("pdv/index.html")
  })

  test("ignores images, URLs and non-HTML files", () => {
    expect(findPreviewHref("![print](print.png) [site](https://exemplo.com) [doc](leiame.md)")).toBeUndefined()
    expect(findPreviewHref("Veja [o site](https://exemplo.com/index.html)")).toBeUndefined()
  })
})

describe("latestBuildPreview", () => {
  test("takes the preview from the latest Build message", () => {
    const messages = [
      assistant("msg_old", "build", "Primeiro [rascunho](rascunho.html)"),
      user("msg_user"),
      assistant("msg_new", "build", "Pronto: [index.html](index.html)"),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "index.html", messageID: "msg_new" })
  })

  test("a newer Build message without a link does not erase an older preview", () => {
    const messages = [
      assistant("msg_old", "build", "Pronto: [index.html](index.html)"),
      assistant("msg_new", "build", "Ajustei o carrinho."),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "index.html", messageID: "msg_old" })
  })

  test("a streaming Build message does not open a preview yet", () => {
    expect(latestBuildPreview([assistant("msg_streaming", "build", "Pronto: [index.html](index.html)", false)])).toBeUndefined()
  })

  test("a Plan message never opens a preview", () => {
    expect(latestBuildPreview([assistant("msg_plan", "plan", "Veja [index.html](index.html)")])).toBeUndefined()
  })

  test("a user message linking a file never opens a preview", () => {
    const linked: SessionMessageInfo = {
      id: "msg_user_link",
      type: "user",
      text: "Abra [index.html](index.html)",
      time: { created: 1 },
    }

    expect(latestBuildPreview([linked])).toBeUndefined()
  })
})
