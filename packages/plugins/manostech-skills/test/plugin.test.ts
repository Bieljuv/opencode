import { describe, expect, test, afterEach } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import plugin, {
  buildArenaCommand,
  buildArenaSkill,
  buildArenaTool,
  buildGraphifyCommand,
  buildGraphifySkill,
  buildPonytailCommand,
  buildPonytailSkill,
  graphifyCommandText,
  ponytailCommandText,
  ponytailLevel,
} from "../index.ts"
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

describe("ponytail skill", () => {
  test("skill ponytail is the upstream v5.3.3 content with pt-BR triggers", async () => {
    const dir = await makeTmp()
    const { ctx, skills, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)

    const skill = skills.get("ponytail")
    expect(skill).toBeDefined()
    const info = buildPonytailSkill()
    expect(String(info.id)).toBe("ponytail")
    expect(String(info.name)).toBe("Ponytail")
    expect(String(info.path)).toBe("skill://ponytail/SKILL.md")
    for (const trigger of ["ponytail", "mais simples", "só o necessário", "sem exagero", "enxuto", "não complica", "yagni"]) {
      expect(info.description ?? "").toContain(trigger)
    }
    expect(info.description ?? "").toContain("full (default)")
    expect(info.description ?? "").toContain("any coding task")
    expect(info.content).toContain("You are a lazy senior developer. The best code is the code never written.")
    expect(info.content).toContain("## The smallest complete change")
    expect(info.content).toContain("Never cut: validation at trust boundaries")
    expect(info.content).toContain("shortcut: <the limit>, <when to upgrade>")
    expect(info.content).toContain("Active for the whole session until the user says \"stop ponytail\"")
    for (const word of ["Claude", "OpenCode", "python3", "Shift+Tab", "free", "paid", "model", "provider", "grátis", "pago", "cota"]) {
      expect(info.content).not.toContain(word)
      expect(info.description ?? "").not.toContain(word)
    }

    // Ponytail is a behavior instruction: no tool, only the skill and the command.
    expect(tools.get("ponytail")).toBeUndefined()
    expect(commands.get("ponytail")).toBeDefined()
  })

  test("setup twice does not duplicate the skill or the command", async () => {
    const dir = await makeTmp()
    const { ctx, skills, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    await plugin.setup(ctx as unknown as Context)
    expect(skills.size).toBe(3)
    expect(commands.size).toBe(3)
  })

  test("user-visible descriptions and command texts stay in pt-BR and name nothing internal", async () => {
    const dir = await makeTmp()
    const { ctx, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    const forbidden = ["Claude", "OpenCode", "Nexus", "grátis", "gratuito", "pago", "cota", "crédito", "roteamento", "US$"]
    const command = buildPonytailCommand({ prompt: async () => undefined } as never)
    expect(command.description).toMatch(/Ponytail/)
    for (const word of forbidden) {
      expect(command.description).not.toContain(word)
      expect((commands.get("ponytail") as unknown as { description: string }).description).not.toContain(word)
    }
    for (const args of ["", "lite", "full", "ultra", "off", "banana"]) {
      for (const word of forbidden) {
        expect(ponytailCommandText(args)).not.toContain(word)
      }
    }
  })
})

describe("ponytail level", () => {
  test("blank or unknown falls back to full, the default", () => {
    expect(ponytailLevel("")).toBe("full")
    expect(ponytailLevel("   ")).toBe("full")
    expect(ponytailLevel("banana")).toBe("full")
    expect(ponytailLevel("FULL")).toBe("full")
  })

  test("lite, ultra and off parse case-insensitively", () => {
    expect(ponytailLevel("lite")).toBe("lite")
    expect(ponytailLevel("ULTRA")).toBe("ultra")
    expect(ponytailLevel(" Off ")).toBe("off")
  })
})

describe("ponytail command", () => {
  test("blank arguments load the skill at the default full level", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildPonytailCommand(session as never)
    await command.execute({
      sessionID: "ses_ponytail_command_test",
      prompt: { text: "   " },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent["sessionID"]).toBe("ses_ponytail_command_test")
    expect(sent["delivery"]).toBe("steer")
    expect(sent["skills"]).toEqual([{ id: "ponytail" }])
    expect(String(sent["text"])).toContain('skill "ponytail"')
    expect(String(sent["text"])).toContain("full")
  })

  test("lite and ultra load the skill at the asked level", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildPonytailCommand(session as never)
    await command.execute({
      sessionID: "ses_ponytail_lite",
      prompt: { text: "lite" },
      delivery: "steer",
    } as never)
    expect(prompts[0]?.["skills"]).toEqual([{ id: "ponytail" }])
    expect(String(prompts[0]?.["text"])).toContain("lite")
    await command.execute({
      sessionID: "ses_ponytail_ultra",
      prompt: { text: "ultra" },
      delivery: "steer",
    } as never)
    expect(prompts[1]?.["skills"]).toEqual([{ id: "ponytail" }])
    expect(String(prompts[1]?.["text"])).toContain("ultra")
  })

  test("off turns the mode off and does not load the skill", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildPonytailCommand(session as never)
    await command.execute({
      sessionID: "ses_ponytail_off",
      prompt: { text: "off" },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]?.["skills"]).toEqual([])
    expect(String(prompts[0]?.["text"])).toContain("Desligue o modo ponytail")
  })
})

describe("graphify skill", () => {
  test("skill graphify is the upstream content with pt-BR triggers", async () => {
    const dir = await makeTmp()
    const { ctx, skills, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)

    const skill = skills.get("graphify")
    expect(skill).toBeDefined()
    const info = buildGraphifySkill()
    expect(String(info.id)).toBe("graphify")
    expect(String(info.name)).toBe("Graphify")
    expect(String(info.path)).toBe("skill://graphify/SKILL.md")
    expect(info.autoinvoke).toBe(true)
    for (const trigger of ["graphify", "mapa do projeto", "mapa do código", "onde fica", "quem chama", "quem usa", "como funciona"]) {
      expect(info.description ?? "").toContain(trigger)
    }
    // Upstream body, adapted in ~10 lines so it passes the repo's own
    // SkillSpector gate (the upstream body scores 88/100 CRITICAL: `rm -f`
    // on its own cache files, "without warning", "do not ask the user" and
    // unpinned `uv tool run`). The fast path, the honesty rules and the
    // "no API key" line are the upstream text, with the flagged patterns
    // reworded (deleting the skill's own cache files now uses the Python
    // interpreter, `uv tool run` is pinned to graphifyy==0.9.106, and the
    // 5,000-node rule is phrased positively).
    expect(info.content).toContain("# /graphify")
    expect(info.content).toContain("## Usage")
    expect(info.content).toContain("## Honesty Rules")
    expect(info.content).toContain("Fast path — existing graph")
    expect(info.content).toContain("graphify-out/graph.json")
    expect(info.content).toContain("graphify needs no API key. Proceed without one")
    expect(info.content).toContain("Never invent an edge. If unsure, use AMBIGUOUS.")
    expect(info.content).not.toContain("opencode")
    // Gate lock: the patterns that made the upstream body score 88/100
    // must stay out, so a future edit cannot silently re-break the CI gate.
    expect(info.content).not.toContain("rm -f")
    expect(info.content).not.toContain("Do not ask the user")
    expect(info.content).not.toContain("Never ask the user")
    expect(info.content).not.toContain("Do not run any commands")
    expect(info.content).not.toContain("without warning")
    expect(info.content).not.toContain("uv tool run --from graphifyy ")
    expect(info.content).toContain("uv tool run --from graphifyy==0.9.106")
    // The body is upstream-faithful, so it keeps the upstream words for the
    // tools it drives ("python3", "Claude Code" as one host example). Those
    // are instructions the model reads, never visible text: the visible
    // masking is enforced by the system prompt, not by editing the body.
    expect(info.content).toContain("python3")

    // Graphify is a behavior instruction: no tool, only the skill and the command.
    expect(tools.get("graphify")).toBeUndefined()
    expect(commands.get("graphify")).toBeDefined()
  })

  test("user-visible descriptions and command texts stay in pt-BR and name nothing internal", async () => {
    const dir = await makeTmp()
    const { ctx, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    const forbidden = ["Claude", "OpenCode", "Nexus", "grátis", "gratuito", "pago", "cota", "crédito", "roteamento", "US$", "free", "paid", "model", "provider"]
    const info = buildGraphifySkill()
    for (const word of forbidden) {
      expect(info.description ?? "").not.toContain(word)
    }
    const command = buildGraphifyCommand({ prompt: async () => undefined } as never)
    expect(command.description).toMatch(/Graphify/)
    for (const word of forbidden) {
      expect(command.description).not.toContain(word)
      expect((commands.get("graphify") as unknown as { description: string }).description).not.toContain(word)
    }
    for (const args of ["", ".", "src --update", "--mode deep"]) {
      for (const word of forbidden) {
        expect(graphifyCommandText(args)).not.toContain(word)
      }
    }
  })
})

describe("graphify command", () => {
  test("blank arguments load the skill for the current directory", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildGraphifyCommand(session as never)
    await command.execute({
      sessionID: "ses_graphify_command_test",
      prompt: { text: "   " },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent["sessionID"]).toBe("ses_graphify_command_test")
    expect(sent["delivery"]).toBe("steer")
    expect(sent["skills"]).toEqual([{ id: "graphify" }])
    expect(String(sent["text"])).toContain('skill "graphify"')
    expect(String(sent["text"])).toContain("diretório atual")
  })

  test("a path and flags pass through to the skill", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildGraphifyCommand(session as never)
    await command.execute({
      sessionID: "ses_graphify_command_args",
      prompt: { text: "src --update" },
      delivery: "steer",
    } as never)
    expect(prompts[0]?.["skills"]).toEqual([{ id: "graphify" }])
    expect(String(prompts[0]?.["text"])).toContain("src --update")
  })
})
