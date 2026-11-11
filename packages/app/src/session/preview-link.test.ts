import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { findPreviewHref, latestBuildPreview } from "./preview-link"

const assistant = (
  id: string,
  agent: SessionMessageAssistant["agent"],
  text: string,
  completed = true,
): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent,
  model: { id: "model", providerID: "provider" },
  content: [{ type: "text", text }],
  time: { created: 1, completed: completed ? 2 : undefined },
})

const assistantParts = (
  id: string,
  agent: SessionMessageAssistant["agent"],
  parts: SessionMessageAssistant["content"],
  completed = true,
): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent,
  model: { id: "model", providerID: "provider" },
  content: parts,
  time: { created: 1, completed: completed ? 2 : undefined },
})

const fileWrite = (
  id: string,
  name: "write" | "edit",
  path: string,
  status: "completed" | "running" = "completed",
): SessionMessageAssistant["content"][number] => ({
  id,
  type: "tool",
  name,
  state:
    status === "completed"
      ? { status: "completed", input: { path }, content: [{ type: "text", text: "ok" }] }
      : { status: "running", input: { path }, metadata: {} },
  time: { created: 1, completed: status === "completed" ? 2 : undefined },
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

  test("a streaming Build message opens the preview once its write finishes", () => {
    const messages = [assistantParts("msg_streaming", "build", [fileWrite("call_write", "write", "index.html")], false)]

    expect(latestBuildPreview(messages)).toEqual({ href: "index.html", messageID: "msg_streaming" })
  })

  test("a streaming Build message previews the page it just wrote", () => {
    const messages = [assistantParts("msg_streaming", "build", [fileWrite("call_write", "write", "loja.html")], false)]

    expect(latestBuildPreview(messages)).toEqual({ href: "loja.html", messageID: "msg_streaming" })
  })

  test("a finished edit opens its page while the turn streams", () => {
    const messages = [assistantParts("msg_streaming", "build", [fileWrite("call_edit", "edit", "sobre.html")], false)]

    expect(latestBuildPreview(messages)).toEqual({ href: "sobre.html", messageID: "msg_streaming" })
  })

  test("a write still running does not open a preview", () => {
    const messages = [
      assistantParts("msg_streaming", "build", [fileWrite("call_write", "write", "index.html", "running")], false),
    ]

    expect(latestBuildPreview(messages)).toBeUndefined()
  })

  test("a finished write of a non-HTML file does not open a preview", () => {
    const messages = [assistantParts("msg_streaming", "build", [fileWrite("call_write", "write", "estilo.css")], false)]

    expect(latestBuildPreview(messages)).toBeUndefined()
  })

  test("a finished Build message without a link previews the file it wrote", () => {
    const messages = [assistantParts("msg_build", "build", [fileWrite("call_write", "write", "index.html")])]

    expect(latestBuildPreview(messages)).toEqual({ href: "index.html", messageID: "msg_build" })
  })

  test("a finished Build message's link wins over its write", () => {
    const messages = [
      assistantParts("msg_build", "build", [
        { type: "text", text: "Pronto: [index.html](index.html)" },
        fileWrite("call_write", "write", "sobre.html"),
      ]),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "index.html", messageID: "msg_build" })
  })

  test("a newer Build turn writing another page moves the preview to it", () => {
    const messages = [
      assistant("msg_old", "build", "Pronto: [index.html](index.html)"),
      assistantParts("msg_new", "build", [fileWrite("call_write", "write", "sobre.html")], false),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "sobre.html", messageID: "msg_new" })
  })

  test("the entry file wins among the files one turn wrote", () => {
    const first = [
      assistantParts(
        "msg_streaming",
        "build",
        [fileWrite("call_a", "write", "sobre.html"), fileWrite("call_b", "write", "index.html")],
        false,
      ),
    ]

    const second = [
      assistantParts(
        "msg_streaming",
        "build",
        [fileWrite("call_a", "write", "index.html"), fileWrite("call_b", "write", "sobre.html")],
        false,
      ),
    ]

    expect(latestBuildPreview(first)).toEqual({ href: "index.html", messageID: "msg_streaming" })
    expect(latestBuildPreview(second)).toEqual({ href: "index.html", messageID: "msg_streaming" })
  })

  test("a Plan message never opens a preview", () => {
    expect(latestBuildPreview([assistant("msg_plan", "plan", "Veja [index.html](index.html)")])).toBeUndefined()
  })

  test("a Plan turn writing a file never opens a preview", () => {
    const messages = [assistantParts("msg_plan", "plan", [fileWrite("call_write", "write", "index.html")], false)]

    expect(latestBuildPreview(messages)).toBeUndefined()
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
