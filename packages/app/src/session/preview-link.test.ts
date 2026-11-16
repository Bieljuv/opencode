import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageAssistant, SessionMessageInfo } from "@opencode/client/promise"
import { collectPreviewMessages, findPreviewHref, latestBuildPreview } from "./preview-link"

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

const previewCall = (
  id: string,
  state: { status: "completed"; input?: { path?: string }; metadata?: { path?: string } } | { status: "running" },
): SessionMessageAssistant["content"][number] => ({
  id,
  type: "tool",
  name: "preview",
  state:
    state.status === "completed"
      ? {
          status: "completed",
          input: state.input ?? {},
          content: [{ type: "text", text: "Opened preview." }],
          ...(state.metadata ? { metadata: state.metadata } : {}),
        }
      : { status: "running", input: {}, metadata: {} },
  time: { created: 1, completed: state.status === "completed" ? 2 : undefined },
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

  test("a Builder subagent message opens a preview like Build", () => {
    expect(latestBuildPreview([assistant("msg_builder", "builder", "Pronto: [index.html](index.html)")])).toEqual({
      href: "index.html",
      messageID: "msg_builder",
    })
  })

  test("a General subagent writing the entry file opens a preview", () => {
    const messages = [assistantParts("msg_general", "general", [fileWrite("call_write", "write", "index.html")], false)]

    expect(latestBuildPreview(messages)).toEqual({ href: "index.html", messageID: "msg_general" })
  })

  test("a Planner message never opens a preview", () => {
    expect(latestBuildPreview([assistant("msg_planner", "planner", "Veja [index.html](index.html)")])).toBeUndefined()
    const messages = [assistantParts("msg_planner", "planner", [fileWrite("call_write", "write", "index.html")], false)]

    expect(latestBuildPreview(messages)).toBeUndefined()
  })

  test("a Reviewer turn writing a file never opens a preview", () => {
    const messages = [assistantParts("msg_reviewer", "reviewer", [fileWrite("call_write", "write", "index.html")], false)]

    expect(latestBuildPreview(messages)).toBeUndefined()
  })

  test("an Explore message never opens a preview", () => {
    expect(latestBuildPreview([assistant("msg_explore", "explore", "Veja [index.html](index.html)")])).toBeUndefined()
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

  test("a completed preview call opens the file its metadata resolved", () => {
    const messages = [
      assistantParts("msg_preview", "build", [
        previewCall("call_preview", { status: "completed", metadata: { path: "public/index.html" } }),
      ]),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "public/index.html", messageID: "msg_preview" })
  })

  test("a completed preview call opens its input path when metadata is missing", () => {
    const messages = [
      assistantParts("msg_preview", "build", [
        previewCall("call_preview", { status: "completed", input: { path: "loja.html" } }),
      ]),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "loja.html", messageID: "msg_preview" })
  })

  test("a completed preview call without a path opens the entry file", () => {
    const messages = [assistantParts("msg_preview", "build", [previewCall("call_preview", { status: "completed" })])]

    expect(latestBuildPreview(messages)).toEqual({ href: "index.html", messageID: "msg_preview" })
  })

  test("a completed preview call opens the preview while its message still streams", () => {
    const messages = [
      assistantParts(
        "msg_streaming",
        "build",
        [previewCall("call_preview", { status: "completed", metadata: { path: "public/index.html" } })],
        false,
      ),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "public/index.html", messageID: "msg_streaming" })
  })

  test("a preview call wins over the message's own link and an older link", () => {
    const messages = [
      assistant("msg_old", "build", "Pronto: [rascunho.html](rascunho.html)"),
      assistantParts("msg_new", "build", [
        { type: "text", text: "Pronto: [index.html](index.html)" },
        previewCall("call_preview", { status: "completed", metadata: { path: "public/index.html" } }),
      ]),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "public/index.html", messageID: "msg_new" })
  })

  test("a preview call with a non-HTML path falls back to the entry file", () => {
    const messages = [
      assistantParts("msg_preview", "build", [
        previewCall("call_preview", { status: "completed", metadata: { path: "estilo.css" } }),
      ]),
    ]

    expect(latestBuildPreview(messages)).toEqual({ href: "index.html", messageID: "msg_preview" })
  })

  test("a preview call still running does not open a preview", () => {
    const messages = [assistantParts("msg_preview", "build", [previewCall("call_preview", { status: "running" })])]

    expect(latestBuildPreview(messages)).toBeUndefined()
  })

  test("a Plan agent's preview call never opens a preview", () => {
    const messages = [
      assistantParts("msg_plan", "plan", [
        previewCall("call_preview", { status: "completed", metadata: { path: "index.html" } }),
      ]),
    ]

    expect(latestBuildPreview(messages)).toBeUndefined()
  })
})

describe("collectPreviewMessages", () => {
  const info = (id: string, parentID?: string) =>
    ({
      id,
      parentID,
      projectID: "proj_1",
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: 1, updated: 2 },
      title: id,
      location: { directory: "/tmp" },
    }) satisfies SessionInfo

  const timed = (id: string, created: number, text: string): SessionMessageInfo => ({
    id,
    type: "assistant",
    agent: "builder",
    model: { id: "model", providerID: "provider" },
    content: [{ type: "text", text }],
    time: { created, completed: created + 1 },
  })

  test("merges a child and a grandchild in time order", () => {
    const sessions = [info("ses_parent"), info("ses_child", "ses_parent"), info("ses_grandchild", "ses_child")]
    const byId: Record<string, SessionMessageInfo[]> = {
      ses_parent: [timed("msg_parent", 1, "Pronto: [rascunho.html](rascunho.html)")],
      ses_child: [timed("msg_child", 3, "Pronto: [index.html](index.html)")],
      ses_grandchild: [timed("msg_grandchild", 2, "Pronto: [loja.html](loja.html)")],
    }

    const merged = collectPreviewMessages("ses_parent", sessions, (id) => byId[id] ?? [])

    expect(merged.map((message) => message.id)).toEqual(["msg_parent", "msg_grandchild", "msg_child"])
    // The newest write wins: the child's entry file is the preview.
    expect(latestBuildPreview(merged)).toEqual({ href: "index.html", messageID: "msg_child" })
  })

  test("ignores sessions that do not descend from the parent", () => {
    const sessions = [info("ses_parent"), info("ses_other"), info("ses_other_child", "ses_other")]
    const byId: Record<string, SessionMessageInfo[]> = {
      ses_parent: [],
      ses_other_child: [timed("msg_other", 2, "Pronto: [index.html](index.html)")],
    }

    expect(collectPreviewMessages("ses_parent", sessions, (id) => byId[id] ?? [])).toEqual([])
  })

  test("a parent cycle stops the walk instead of looping", () => {
    const sessions = [info("ses_parent", "ses_child"), info("ses_child", "ses_parent")]
    const byId: Record<string, SessionMessageInfo[]> = {
      ses_child: [timed("msg_child", 2, "Pronto: [index.html](index.html)")],
    }

    expect(collectPreviewMessages("ses_parent", sessions, (id) => byId[id] ?? []).map((message) => message.id)).toEqual([
      "msg_child",
    ])
  })
})
