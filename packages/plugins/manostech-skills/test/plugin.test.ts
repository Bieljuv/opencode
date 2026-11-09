import { describe, expect, test, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import plugin, { buildArenaCommand, buildArenaSkill, buildArenaTool } from "../index.ts"
import { ArenaError } from "../src/bracket.ts"

const tmpDirs: string[] = []

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop() as string
    await rm(dir, { recursive: true, force: true })
  }
})

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "arena-plugin-test-"))
  tmpDirs.push(dir)
  return dir
}

// The plugin only reads location.project.directory and permission.assert from
// the host, so a small stub stands in for the whole plugin context.
function makeCtx(directory: string, assertCalls: Array<Record<string, unknown>> = []) {
  const skills = new Map<string, { id: string }>()
  const tools = new Map<string, { name: string }>()
  const commands = new Map<string, { name: string }>()
  const ctx = {
    location: { project: { directory } },
    permission: {
      assert: async (input: Record<string, unknown>) => {
        assertCalls.push(input)
      },
    },
    skill: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          get: (id: string) => skills.get(id),
          add: (skill: { id: string }) => {
            skills.set(skill.id, skill)
          },
        })
        return { dispose: async () => {} }
      },
    },
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          get: (id: string) => tools.get(id),
          add: (tool: { name: string }) => {
            tools.set(tool.name, tool)
          },
        })
        return { dispose: async () => {} }
      },
    },
    command: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          add: (command: { name: string }) => {
            commands.set(command.name, command)
          },
        })
        return { dispose: async () => {} }
      },
    },
  }
  return { ctx, skills, tools, commands, assertCalls }
}

function fakeToolContext(): ToolContext {
  return {
    sessionID: "ses_arena_plugin_test",
    agent: "build",
    messageID: "msg_arena_plugin_test",
    id: "call_arena_plugin_test",
    signal: new AbortController().signal,
    progress: async () => {},
  } as unknown as ToolContext
}

describe("setup registers the skill, the tool and the command", () => {
  test("skill arena with pt-BR triggers, tool arena and command arena", async () => {
    const dir = await makeTmp()
    const { ctx, skills, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)

    const skill = skills.get("arena")
    expect(skill).toBeDefined()
    const info = buildArenaSkill()
    expect(String(info.id)).toBe("arena")
    expect(String(info.name)).toBe("Arena")
    expect(String(info.path)).toBe("skill://arena/SKILL.md")
    for (const trigger of ["resposta ruim", "tenta de novo", "não gostei", "faz de novo melhor", "arena", "faz eles competir"]) {
      expect(info.description ?? "").toContain(trigger)
    }
    expect(info.description ?? "").toContain("default 20")
    expect(info.content).toContain("<!-- template:competitor -->")
    expect(info.content).not.toContain("python3")
    expect(info.content).not.toContain("bracket.py")
    expect(info.content).not.toContain("Shift+Tab")
    expect(info.content).not.toContain("Claude")

    expect(tools.get("arena")).toBeDefined()
    expect(commands.get("arena")).toBeDefined()
  })

  test("user-visible descriptions stay in pt-BR and name nothing internal", async () => {
    const dir = await makeTmp()
    const { ctx, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    const forbidden = ["Claude", "OpenCode", "Nexus", "grátis", "gratuito", "pago", "cota", "crédito", "roteamento", "US$"]
    const tool = buildArenaTool({ directory: dir, assertEdit: async () => {} })
    expect(tool.description).toMatch(/Arena/)
    for (const word of forbidden) {
      expect(tool.description).not.toContain(word)
      expect((tools.get("arena") as unknown as { description: string }).description).not.toContain(word)
    }
    const command = buildArenaCommand({ prompt: async () => undefined } as never)
    expect(command.description).toMatch(/Arena/)
    for (const word of forbidden) {
      expect(command.description).not.toContain(word)
      expect((commands.get("arena") as unknown as { description: string }).description).not.toContain(word)
    }
  })
})

describe("arena tool", () => {
  test("plan --agents 20 is the default size and needs no permission", async () => {
    const dir = await makeTmp()
    const assertCalls: Array<Record<string, unknown>> = []
    const tool = buildArenaTool({
      directory: dir,
      assertEdit: async (context) => {
        assertCalls.push({ ...context })
      },
    })
    const planned = await tool.execute({ command: "plan", args: ["--agents", "20"] }, fakeToolContext())
    expect(planned.output?.code).toBe(0)
    expect(planned.output?.stdout).toContain("20 agents, 5 rounds")
    expect(planned.output?.stdout).toContain("115")
    const def = await tool.execute({ command: "plan" }, fakeToolContext())
    expect(def.output?.stdout).toContain("20 agents, 5 rounds")
    expect(assertCalls).toEqual([])
  })

  test("init then next runs in a temp dir and init asks for edit permission", async () => {
    const dir = await makeTmp()
    const assertCalls: Array<Record<string, unknown>> = []
    const tool = buildArenaTool({
      directory: dir,
      assertEdit: async (context) => {
        assertCalls.push({ sessionID: context.sessionID, agent: context.agent })
      },
    })
    const taskFile = path.join(dir, "task.md")
    const { writeFile } = await import("node:fs/promises")
    await writeFile(taskFile, "Write a haiku about rain.\n", "utf8")
    const runDir = path.join(dir, "run")
    const init = await tool.execute(
      { command: "init", args: ["--agents", "4", "--seed", "7", "--task-file", taskFile, "--dir", runDir] },
      fakeToolContext(),
    )
    expect(init.output?.code).toBe(0)
    expect(init.output?.stdout).toContain("arena ready")
    expect(assertCalls.length).toBe(1)
    const next = await tool.execute({ command: "next", args: ["--dir", runDir] }, fakeToolContext())
    expect(next.output?.code).toBe(0)
    expect(next.output?.stdout).toContain("spawn")
    expect(assertCalls.length).toBe(1)
  })

  test("unknown commands and bad sizing fail as ArenaError", async () => {
    const dir = await makeTmp()
    const tool = buildArenaTool({ directory: dir, assertEdit: async () => {} })
    await expect(tool.execute({ command: "nope" }, fakeToolContext())).rejects.toThrow(ArenaError)
    await expect(tool.execute({ command: "plan", args: ["--agents", "0"] }, fakeToolContext())).rejects.toThrow(ArenaError)
  })
})

describe("arena command", () => {
  test("injects a prompt that loads the arena skill with the typed arguments", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildArenaCommand(session as never)
    await command.execute({
      sessionID: "ses_arena_command_test",
      prompt: { text: "--quick escreve um haiku" },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent["sessionID"]).toBe("ses_arena_command_test")
    expect(sent["delivery"]).toBe("steer")
    expect(sent["skills"]).toEqual([{ id: "arena" }])
    expect(String(sent["text"])).toContain('skill "arena"')
    expect(String(sent["text"])).toContain("--quick escreve um haiku")
  })

  test("blank arguments fall back to the conversation task", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildArenaCommand(session as never)
    await command.execute({
      sessionID: "ses_arena_command_blank",
      prompt: { text: "   " },
      delivery: "steer",
    } as never)
    expect(String(prompts[0]?.["text"])).toContain("(nenhum")
  })
})
