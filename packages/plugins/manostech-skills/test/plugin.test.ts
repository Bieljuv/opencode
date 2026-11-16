import { describe, expect, test, afterEach } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
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
  buildHyperframesSkill,
  buildImpeccableCommand,
  buildImpeccableSkill,
  buildOpenverseCommand,
  buildOpenverseSkill,
  buildPonytailCommand,
  buildPonytailSkill,
  buildRealSfxCommand,
  buildRealSfxSkill,
  buildStrixCommand,
  buildStrixSkill,
  buildVideoCommand,
  graphifyCommandText,
  impeccableCommandText,
  openverseCommandText,
  ponytailCommandText,
  ponytailLevel,
  realSfxCommandText,
  strixCommandText,
  videoCommandText,
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
    // Eight skills (arena, ponytail, graphify, hyperframes, openverse,
    // real-sfx, strix, impeccable) and eight commands (arena, ponytail,
    // graphify, openverse, real-sfx, strix, impeccable, video): setup twice
    // still registers each one once.
    expect(skills.size).toBe(8)
    expect(commands.size).toBe(8)
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
  test("skill graphify is the adapted content with pt-BR triggers", async () => {
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
    // Adapted from the upstream Graphify skill: the pipeline, the honesty
    // rules and the fast path are kept, but the supporting procedures the
    // skill cites live in references/ beside it (the upstream ships them
    // separately and they were missing), Step 1 only detects the tool —
    // it never installs, downloads or upgrades anything — and when the
    // tool is not available the agent builds the native lightweight map
    // (see the "graphify references" suite). The body names no provider,
    // model, key or install command: the upstream tip that printed a
    // provider key and an install command to the user is gone, so the
    // old excuse ("Claude Code" / "python3" are never visible text) no
    // longer holds for any line of the body.
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
    // Mask lock: no provider/model/key/install word anywhere in the body.
    // Lowercased once, so "Claude Code", "GEMINI_API_KEY" and "GitHub"
    // cannot hide behind capital letters. Bare "model" / "provider" are
    // not on the list: the body uses "the model" generically once, and
    // the mask bans names, not the generic word.
    const lower = info.content.toLowerCase()
    for (const word of ["claude", "opencode", "gemini", "google", "anthropic", "openai", "github", "pip install", "uv tool install", "uv tool run", "break-system-packages", "sponsors", "whisper", "free", "paid"]) {
      expect(lower).not.toContain(word)
    }
    // The native map is a real procedure with fixed outputs, not a
    // promise in the system prompt.
    expect(info.content).toContain("## Native lightweight map")
    expect(info.content).toContain("graphify-out/GRAPH_REPORT.md")

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

describe("graphify references", () => {
  const skillDir = new URL("../skills/graphify/", import.meta.url)

  function citedReferences(content: string): string[] {
    return [...new Set([...content.matchAll(/references\/([A-Za-z0-9_.-]+\.md)/g)].map((m) => m[1] as string))]
  }

  test("every references/ file the skill cites exists beside SKILL.md", async () => {
    const info = buildGraphifySkill()
    const cited = citedReferences(info.content)
    // The eight procedures the skill cites. Locking the count means a
    // future citation cannot point at a file nobody wrote.
    expect(cited).toHaveLength(8)
    for (const name of cited) {
      expect(await Bun.file(new URL(`references/${name}`, skillDir)).exists()).toBe(true)
    }
  })

  test("cited references are mask-clean and never install anything", async () => {
    const info = buildGraphifySkill()
    const forbidden = ["claude", "opencode", "gemini", "google", "anthropic", "openai", "github", "pip install", "uv tool install", "uv tool run", "break-system-packages", "sponsors", "whisper", "free", "paid"]
    const gate = ["rm -f", "do not ask the user", "never ask the user", "do not run any commands", "without warning"]
    for (const name of citedReferences(info.content)) {
      const text = (await Bun.file(new URL(`references/${name}`, skillDir)).text()).toLowerCase()
      for (const word of [...forbidden, ...gate]) {
        expect(text).not.toContain(word)
      }
    }
  })

  test("step 1 detects the tool and never installs it", () => {
    const info = buildGraphifySkill()
    expect(info.content).toContain("Detect only")
    for (const word of ["uv tool install", "pip install", "uv tool run", "break-system-packages"]) {
      expect(info.content).not.toContain(word)
    }
    expect(info.content).toContain("stop the pipeline here and run the native lightweight map")
  })

  test("the native lightweight map is a real procedure with fixed outputs", () => {
    const info = buildGraphifySkill()
    for (const marker of [
      "## Native lightweight map",
      "graphify-out/GRAPH_REPORT.md",
      "graphify-out/graph.json",
      "Module map",
      "God nodes",
      "never run `graphify query`",
    ]) {
      expect(info.content).toContain(marker)
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

describe("openverse skill", () => {
  test("skill openverse is the new sound-search skill with pt-BR triggers", async () => {
    const dir = await makeTmp()
    const { ctx, skills, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)

    const skill = skills.get("openverse")
    expect(skill).toBeDefined()
    const info = buildOpenverseSkill()
    expect(String(info.id)).toBe("openverse")
    expect(String(info.name)).toBe("Openverse")
    expect(String(info.path)).toBe("skill://openverse/SKILL.md")
    expect(info.autoinvoke).toBe(true)
    for (const trigger of ["openverse", "som para o vídeo", "efeito sonoro", "achar som", "música de fundo", "ambiente sonoro"]) {
      expect(info.description ?? "").toContain(trigger)
    }
    // The skill is written here (no upstream skill): it searches the
    // Openverse audio API, picks the best result, downloads the direct
    // file and records the license and the attribution line.
    expect(info.content).toContain("# /openverse")
    expect(info.content).toContain("api.openverse.org/v1/audio/")
    expect(info.content).toContain("license_type=commercial")
    expect(info.content).toContain("license=cc0")
    expect(info.content).toContain("attribution")
    expect(info.content).toContain("Sem chave de API e sem cadastro")
    expect(info.content).toContain("CC0")
    expect(info.content).toContain("CC BY")
    expect(info.content).not.toContain("opencode")
    // The masking words stay out of the skill text, and the gate patterns
    // that broke the upstream Graphify body stay out too.
    for (const word of ["Claude", "OpenCode", "python3", "Python", "Shift+Tab", "free", "paid", "model", "provider", "grátis", "pago", "cota"]) {
      expect(info.content).not.toContain(word)
      expect(info.description ?? "").not.toContain(word)
    }
    expect(info.content).not.toContain("rm -f")
    expect(info.content).not.toContain("Do not ask the user")
    expect(info.content).not.toContain("Never ask the user")
    expect(info.content).not.toContain("Do not run any commands")
    expect(info.content).not.toContain("without warning")

    // Openverse is a behavior instruction: no tool, only the skill and the command.
    expect(tools.get("openverse")).toBeUndefined()
    expect(commands.get("openverse")).toBeDefined()
  })

  test("user-visible descriptions and command texts stay in pt-BR and name nothing internal", async () => {
    const dir = await makeTmp()
    const { ctx, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    const forbidden = ["Claude", "OpenCode", "Nexus", "grátis", "gratuito", "pago", "cota", "crédito", "roteamento", "US$", "free", "paid", "model", "provider"]
    const info = buildOpenverseSkill()
    for (const word of forbidden) {
      expect(info.description ?? "").not.toContain(word)
    }
    const command = buildOpenverseCommand({ prompt: async () => undefined } as never)
    expect(command.description).toMatch(/Openverse/)
    for (const word of forbidden) {
      expect(command.description).not.toContain(word)
      expect((commands.get("openverse") as unknown as { description: string }).description).not.toContain(word)
    }
    for (const args of ["", "whoosh", "clique de botão", "chuva"]) {
      for (const word of forbidden) {
        expect(openverseCommandText(args)).not.toContain(word)
      }
    }
  })
})

describe("openverse command", () => {
  test("blank arguments load the skill for what the conversation asks", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildOpenverseCommand(session as never)
    await command.execute({
      sessionID: "ses_openverse_command_test",
      prompt: { text: "   " },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent["sessionID"]).toBe("ses_openverse_command_test")
    expect(sent["delivery"]).toBe("steer")
    expect(sent["skills"]).toEqual([{ id: "openverse" }])
    expect(String(sent["text"])).toContain('skill "openverse"')
    expect(String(sent["text"])).toContain("(nenhum")
  })

  test("the search terms pass through to the skill", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildOpenverseCommand(session as never)
    await command.execute({
      sessionID: "ses_openverse_command_args",
      prompt: { text: "whoosh" },
      delivery: "steer",
    } as never)
    expect(prompts[0]?.["skills"]).toEqual([{ id: "openverse" }])
    expect(String(prompts[0]?.["text"])).toContain("whoosh")
  })
})

describe("real-sfx skill", () => {
  test("skill real-sfx is the upstream Real SFX skill adapted to FFmpeg and Openverse", async () => {
    const dir = await makeTmp()
    const { ctx, skills, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)

    const skill = skills.get("real-sfx")
    expect(skill).toBeDefined()
    const info = buildRealSfxSkill()
    expect(String(info.id)).toBe("real-sfx")
    expect(String(info.name)).toBe("Real SFX")
    expect(String(info.path)).toBe("skill://real-sfx/SKILL.md")
    expect(info.autoinvoke).toBe(true)
    for (const trigger of ["real-sfx", "som no vídeo", "sonorizar", "colocar som", "efeito no vídeo", "som no frame"]) {
      expect(info.description ?? "").toContain(trigger)
    }
    // Adapted from the upstream Real SFX skill (Clipwing, MIT): the rules,
    // the moment kinds, the levels and the taste rules are kept, but the
    // upstream's own Python scripts are NOT bundled — the agent finds the
    // moments (project cue list, HyperFrames data-start timeline or frame
    // analysis), picks real recordings (user library or Openverse) and mixes
    // them with FFmpeg directly. No bundled sound library; when FFmpeg is
    // not available the agent still finds the moments and the sounds and
    // leaves the exact mix commands ready, without asking for an install.
    expect(info.content).toContain("# /real-sfx")
    expect(info.content).toContain("O som nunca é sintetizado")
    expect(info.content).toContain("data-start")
    expect(info.content).toContain("adelay")
    expect(info.content).toContain("amix")
    expect(info.content).toContain("loudnorm")
    expect(info.content).toContain("Se o FFmpeg não estiver disponível")
    expect(info.content).toContain("lista de escuta")
    expect(info.content).toContain("Regras de gosto")
    expect(info.content).not.toContain("opencode")
    // The masking words stay out of the skill text, and the gate patterns
    // that broke the upstream Graphify body stay out too. The adaptation
    // removes the upstream's Python dependency entirely, so "Python" is
    // locked out of the content as well.
    for (const word of ["Claude", "OpenCode", "python3", "Python", "Shift+Tab", "free", "paid", "model", "provider", "grátis", "pago", "cota"]) {
      expect(info.content).not.toContain(word)
      expect(info.description ?? "").not.toContain(word)
    }
    expect(info.content).not.toContain("rm -f")
    expect(info.content).not.toContain("Do not ask the user")
    expect(info.content).not.toContain("Never ask the user")
    expect(info.content).not.toContain("Do not run any commands")
    expect(info.content).not.toContain("without warning")

    // Real SFX is a behavior instruction: no tool, only the skill and the command.
    expect(tools.get("real-sfx")).toBeUndefined()
    expect(commands.get("real-sfx")).toBeDefined()
  })

  test("user-visible descriptions and command texts stay in pt-BR and name nothing internal", async () => {
    const dir = await makeTmp()
    const { ctx, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    const forbidden = ["Claude", "OpenCode", "Nexus", "grátis", "gratuito", "pago", "cota", "crédito", "roteamento", "US$", "free", "paid", "model", "provider"]
    const info = buildRealSfxSkill()
    for (const word of forbidden) {
      expect(info.description ?? "").not.toContain(word)
    }
    const command = buildRealSfxCommand({ prompt: async () => undefined } as never)
    expect(command.description).toMatch(/Real SFX/)
    for (const word of forbidden) {
      expect(command.description).not.toContain(word)
      expect((commands.get("real-sfx") as unknown as { description: string }).description).not.toContain(word)
    }
    for (const args of ["", "video.mp4", "cues.json"]) {
      for (const word of forbidden) {
        expect(realSfxCommandText(args)).not.toContain(word)
      }
    }
  })
})

describe("real-sfx command", () => {
  test("blank arguments load the skill for the video in the conversation", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildRealSfxCommand(session as never)
    await command.execute({
      sessionID: "ses_real_sfx_command_test",
      prompt: { text: "   " },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent["sessionID"]).toBe("ses_real_sfx_command_test")
    expect(sent["delivery"]).toBe("steer")
    expect(sent["skills"]).toEqual([{ id: "real-sfx" }])
    expect(String(sent["text"])).toContain('skill "real-sfx"')
    expect(String(sent["text"])).toContain("(nenhum")
  })

  test("the video and the cue list pass through to the skill", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildRealSfxCommand(session as never)
    await command.execute({
      sessionID: "ses_real_sfx_command_args",
      prompt: { text: "video.mp4 cues.json" },
      delivery: "steer",
    } as never)
    expect(prompts[0]?.["skills"]).toEqual([{ id: "real-sfx" }])
    expect(String(prompts[0]?.["text"])).toContain("video.mp4 cues.json")
  })
})

describe("strix skill", () => {
  test("skill strix is the old Forge editor's Strix template, adapted to offer the audit", async () => {
    const dir = await makeTmp()
    const { ctx, skills, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)

    const skill = skills.get("strix")
    expect(skill).toBeDefined()
    const info = buildStrixSkill()
    expect(String(info.id)).toBe("strix")
    expect(String(info.name)).toBe("Strix")
    expect(String(info.path)).toBe("skill://strix/SKILL.md")
    expect(info.autoinvoke).toBe(true)
    for (const trigger of ["strix", "auditoria de segurança", "pentest", "blindar o projeto", "vulnerabilidade", "revisar a segurança"]) {
      expect(info.description ?? "").toContain(trigger)
    }
    // Ported from the old Forge editor's Strix template: the five-step
    // method (find, prove, prioritize, fix and retest, report) and the
    // hard rules are kept, but the delivery-gate sentence is softened —
    // the audit is offered before delivery and runs only when the user
    // asks or accepts, never on every turn — and the platform install
    // instruction is dropped: the agent uses the Strix platform's
    // findings only when the client already has access, and never
    // installs anything.
    expect(info.content).toContain("# /strix")
    expect(info.content).toContain("OFEREÇA a auditoria ao usuário")
    expect(info.content).toContain("ACHE:")
    expect(info.content).toContain("PROVE:")
    expect(info.content).toContain("PRIORIZE")
    expect(info.content).toContain("CORRIJA")
    expect(info.content).toContain("REGRAS DURAS")
    expect(info.content).toContain("só audite sistemas que o usuário possui")
    expect(info.content).not.toContain("opencode")
    // The masking words stay out of the skill text. The adaptation
    // removes the install instruction, so "install" is locked out too.
    for (const word of ["Claude", "OpenCode", "python3", "Python", "Shift+Tab", "free", "paid", "model", "provider", "grátis", "pago", "cota", "install", "instal"]) {
      expect(info.content).not.toContain(word)
      expect(info.description ?? "").not.toContain(word)
    }

    // Strix is a behavior instruction: no tool, only the skill and the command.
    expect(tools.get("strix")).toBeUndefined()
    expect(commands.get("strix")).toBeDefined()
  })

  test("user-visible descriptions and command texts stay in pt-BR and name nothing internal", async () => {
    const dir = await makeTmp()
    const { ctx, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    const forbidden = ["Claude", "OpenCode", "Nexus", "grátis", "gratuito", "pago", "cota", "crédito", "roteamento", "US$", "free", "paid", "model", "provider"]
    const info = buildStrixSkill()
    for (const word of forbidden) {
      expect(info.description ?? "").not.toContain(word)
    }
    const command = buildStrixCommand({ prompt: async () => undefined } as never)
    expect(command.description).toMatch(/Strix/)
    for (const word of forbidden) {
      expect(command.description).not.toContain(word)
      expect((commands.get("strix") as unknown as { description: string }).description).not.toContain(word)
    }
    for (const args of ["", "a rota de login", "o sistema atual"]) {
      for (const word of forbidden) {
        expect(strixCommandText(args)).not.toContain(word)
      }
    }
  })
})

describe("strix command", () => {
  test("blank arguments load the skill for the current project", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildStrixCommand(session as never)
    await command.execute({
      sessionID: "ses_strix_command_test",
      prompt: { text: "   " },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent["sessionID"]).toBe("ses_strix_command_test")
    expect(sent["delivery"]).toBe("steer")
    expect(sent["skills"]).toEqual([{ id: "strix" }])
    expect(String(sent["text"])).toContain('skill "strix"')
    expect(String(sent["text"])).toContain("(nenhum")
  })

  test("the audit target passes through to the skill", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildStrixCommand(session as never)
    await command.execute({
      sessionID: "ses_strix_command_args",
      prompt: { text: "a rota de login" },
      delivery: "steer",
    } as never)
    expect(prompts[0]?.["skills"]).toEqual([{ id: "strix" }])
    expect(String(prompts[0]?.["text"])).toContain("a rota de login")
  })
})

describe("impeccable skill", () => {
  test("skill impeccable is the upstream skill, adapted to this app", async () => {
    const dir = await makeTmp()
    const { ctx, skills, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)

    const skill = skills.get("impeccable")
    expect(skill).toBeDefined()
    const info = buildImpeccableSkill()
    expect(String(info.id)).toBe("impeccable")
    expect(String(info.name)).toBe("Impeccable")
    expect(String(info.path)).toBe("skill://impeccable/SKILL.md")
    expect(info.autoinvoke).toBe(true)
    for (const trigger of ["melhorar o visual", "revisar o visual", "auditar a interface", "criticar o layout", "modo ao vivo"]) {
      expect(info.description ?? "").toContain(trigger)
    }
    // Adapted from the upstream Impeccable skill (pbakaus/impeccable,
    // Apache 2.0): the 62-rule detector, the 24 commands and the live
    // mode are kept, but the engine ships with the app — the launcher,
    // the first-run download and the other harnesses' hook installs are
    // gone, the automatic check is built into the agent, and the pin
    // command does not exist here.
    expect(info.content).toContain("impeccable context")
    expect(info.content).toContain("## Setup")
    expect(info.content).toContain("## Commands")
    expect(info.content).toContain("reference/craft-floor.md")
    expect(info.content).toContain("the engine comes with the app and is never downloaded")
    expect(info.content).toContain("Detector unavailable")
    expect(info.content).toContain("not available in this app: every `/impeccable` command already ships inside the app")
    expect(info.content).toContain("unless the project's hook is off")
    for (const word of ["Claude", "OpenCode", "python3", "Python", "Shift+Tab", "free", "paid", "model", "provider", "grátis", "pago", "cota", "install", "instal"]) {
      expect(info.content).not.toContain(word)
      expect(info.description ?? "").not.toContain(word)
    }

    // Impeccable is a behavior instruction: no tool, only the skill and the command.
    expect(tools.get("impeccable")).toBeUndefined()
    expect(commands.get("impeccable")).toBeDefined()
  })

  test("the detector is only 'impeccable detect'; a failed scan is reported, never improvised", () => {
    const info = buildImpeccableSkill()
    // The detector CLI is `impeccable detect`; the bundled engine has no
    // `audit` subcommand (it fails with `Unknown command: "audit"`), and
    // `/impeccable audit` is a slash command — an agent procedure — never
    // a shell command. The lookarounds pin that: the only "impeccable
    // audit" in the skill is the slash form, and `impeccable
    // audit-storage` (a real helper subcommand) does not count.
    expect(info.content).toContain("impeccable detect --json")
    expect(info.content).toContain("Unknown command")
    expect(info.content.match(/(?<!\/)impeccable audit(?!-)/g)).toBeNull()
    // A failed scan stops the check and tells the user it did not run,
    // in the user's language; the agent never improvises detector output.
    expect(info.content).toContain("Detector failure")
    expect(info.content).toContain("A verificação visual não rodou")
  })

  test("user-visible descriptions and command texts stay in pt-BR and name nothing internal", async () => {
    const dir = await makeTmp()
    const { ctx, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    const forbidden = ["Claude", "OpenCode", "Nexus", "grátis", "gratuito", "pago", "cota", "crédito", "roteamento", "US$", "free", "paid", "model", "provider"]
    const info = buildImpeccableSkill()
    for (const word of forbidden) {
      expect(info.description ?? "").not.toContain(word)
    }
    const command = buildImpeccableCommand({ prompt: async () => undefined } as never)
    expect(command.description).toMatch(/Impeccable/)
    for (const word of forbidden) {
      expect(command.description).not.toContain(word)
      expect((commands.get("impeccable") as unknown as { description: string }).description).not.toContain(word)
    }
    for (const args of ["", "a tela de login", "o painel"]) {
      for (const word of forbidden) {
        expect(impeccableCommandText(args)).not.toContain(word)
      }
    }
  })
})

describe("impeccable references", () => {
  const skillDir = new URL("../skills/impeccable/", import.meta.url)

  function citedReferences(content: string): string[] {
    return [...new Set([...content.matchAll(/reference\/([A-Za-z0-9_.-]+\.md)/g)].map((m) => m[1] as string))]
  }

  async function allReferenceFiles(): Promise<string[]> {
    const entries = await readdir(new URL("reference/", skillDir), { recursive: true })
    return (entries as unknown as string[]).filter((name) => name.endsWith(".md")).sort()
  }

  test("every references/ file the skill cites exists beside SKILL.md", async () => {
    const info = buildImpeccableSkill()
    const cited = citedReferences(info.content)
    // The 36 procedures the skill cites. Locking the count means a
    // future citation cannot point at a file nobody wrote.
    expect(cited).toHaveLength(36)
    for (const name of cited) {
      expect(await Bun.file(new URL(`reference/${name}`, skillDir)).exists()).toBe(true)
    }
  })

  test("every shipped reference file is mask-clean", async () => {
    const forbidden = ["claude", "opencode", "gemini", "google", "anthropic", "openai", "github", "pip install", "uv tool install", "uv tool run", "break-system-packages", "sponsors", "whisper", "free", "paid"]
    const files = await allReferenceFiles()
    // 45 procedures plus the 4 degraded/ fallbacks. Locking the count
    // means a future port cannot silently ship a file this test never saw.
    expect(files).toHaveLength(49)
    for (const name of files) {
      const text = (await Bun.file(new URL(`reference/${name}`, skillDir)).text()).toLowerCase()
      for (const word of forbidden) {
        expect(text).not.toContain(word)
      }
    }
  })

  test("routing and hooks name the detector command and the failure rule", async () => {
    const routing = await Bun.file(new URL("reference/routing.md", skillDir)).text()
    expect(routing).toContain("impeccable detect --json")
    expect(routing).toContain("must be reported, never silently skipped")
    const hooks = await Bun.file(new URL("reference/hooks.md", skillDir)).text()
    expect(hooks).toContain("impeccable detect --json <changed files>")
    expect(hooks).toContain("never presents a review")
  })
})

describe("impeccable command", () => {
  test("blank arguments load the skill for the current project", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildImpeccableCommand(session as never)
    await command.execute({
      sessionID: "ses_impeccable_command_test",
      prompt: { text: "   " },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent["sessionID"]).toBe("ses_impeccable_command_test")
    expect(sent["delivery"]).toBe("steer")
    expect(sent["skills"]).toEqual([{ id: "impeccable" }])
    expect(String(sent["text"])).toContain('skill "impeccable"')
    expect(String(sent["text"])).toContain("(nenhum")
  })

  test("the visual target passes through to the skill", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildImpeccableCommand(session as never)
    await command.execute({
      sessionID: "ses_impeccable_command_args",
      prompt: { text: "a tela de login" },
      delivery: "steer",
    } as never)
    expect(prompts[0]?.["skills"]).toEqual([{ id: "impeccable" }])
    expect(String(prompts[0]?.["text"])).toContain("a tela de login")
  })
})

describe("hyperframes skill", () => {
  test("skill hyperframes is the workspace HyperFrames skill adapted to the bundled tools", async () => {
    const dir = await makeTmp()
    const { ctx, skills, tools, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)

    const skill = skills.get("hyperframes")
    expect(skill).toBeDefined()
    const info = buildHyperframesSkill()
    expect(String(info.id)).toBe("hyperframes")
    expect(String(info.name)).toBe("HyperFrames")
    expect(String(info.path)).toBe("skill://hyperframes/SKILL.md")
    expect(info.autoinvoke).toBe(true)
    for (const trigger of ["hyperframes", "fazer vídeo", "vídeo do produto", "renderizar vídeo", "clipe vertical"]) {
      expect(info.description ?? "").toContain(trigger)
    }
    // Adapted from the workspace HyperFrames skill: the contract, the house
    // rules and the work cycle are kept, but the environment section is
    // rewritten for this app — Node and FFmpeg come bundled with the
    // installer, never assumed from the user's machine — and the skill ends
    // in the single flow (render, add real sound, deliver with a player
    // page) instead of stopping at the MP4.
    expect(info.content).toContain("# /video")
    expect(info.content).toContain("data-start")
    expect(info.content).toContain("data-duration")
    expect(info.content).toContain("hyperframes doctor")
    expect(info.content).toContain("hyperframes browser ensure")
    expect(info.content).toContain("FLUXO ÚNICO")
    expect(info.content).toContain("real-sfx")
    expect(info.content).toContain("openverse")
    expect(info.content).toContain("assistir.html")
    expect(info.content).toContain("video-pronto_sfx.mp4")
    expect(info.content).toContain("sem zoom nem efeito Ken Burns")
    expect(info.content).toContain("60 segundos ou mais")
    expect(info.content).not.toContain("opencode")
    // The old workspace claim ("Node e FFmpeg JÁ VÊM DENTRO do Editor")
    // described the other desktop, not this one: it must not survive here.
    expect(info.content).not.toContain("JÁ VÊM DENTRO")
    // The masking words stay out of the skill text, and the gate patterns
    // that broke the upstream Graphify body stay out too.
    for (const word of ["Claude", "OpenCode", "python3", "Python", "Shift+Tab", "free", "paid", "model", "provider", "grátis", "pago", "cota"]) {
      expect(info.content).not.toContain(word)
      expect(info.description ?? "").not.toContain(word)
    }
    expect(info.content).not.toContain("rm -f")
    expect(info.content).not.toContain("Do not ask the user")
    expect(info.content).not.toContain("Never ask the user")
    expect(info.content).not.toContain("Do not run any commands")
    expect(info.content).not.toContain("without warning")

    // HyperFrames is a behavior instruction: no tool, only the skill. The
    // entry point is the /video command, which loads the three flow skills.
    expect(tools.get("hyperframes")).toBeUndefined()
    expect(commands.get("hyperframes")).toBeUndefined()
    expect(commands.get("video")).toBeDefined()
  })

  test("user-visible descriptions and command texts stay in pt-BR and name nothing internal", async () => {
    const dir = await makeTmp()
    const { ctx, commands } = makeCtx(dir)
    await plugin.setup(ctx as unknown as Context)
    const forbidden = ["Claude", "OpenCode", "Nexus", "grátis", "gratuito", "pago", "cota", "crédito", "roteamento", "US$", "free", "paid", "model", "provider"]
    const info = buildHyperframesSkill()
    for (const word of forbidden) {
      expect(info.description ?? "").not.toContain(word)
    }
    const command = buildVideoCommand({ prompt: async () => undefined } as never)
    expect(command.description).toMatch(/Vídeo/)
    for (const word of forbidden) {
      expect(command.description).not.toContain(word)
      expect((commands.get("video") as unknown as { description: string }).description).not.toContain(word)
    }
    for (const args of ["", "lançamento do app"]) {
      for (const word of forbidden) {
        expect(videoCommandText(args)).not.toContain(word)
      }
    }
  })
})

describe("video command", () => {
  test("blank arguments load the three flow skills for what the conversation asks", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildVideoCommand(session as never)
    await command.execute({
      sessionID: "ses_video_command_test",
      prompt: { text: "   " },
      delivery: "steer",
    } as never)
    expect(prompts).toHaveLength(1)
    const sent = prompts[0]
    expect(sent["sessionID"]).toBe("ses_video_command_test")
    expect(sent["delivery"]).toBe("steer")
    // One flow, three skills: render (hyperframes), add sound (real-sfx),
    // find the sounds (openverse). No step is left for the agent to remember.
    expect(sent["skills"]).toEqual([{ id: "hyperframes" }, { id: "real-sfx" }, { id: "openverse" }])
    expect(String(sent["text"])).toContain('skill "hyperframes"')
    expect(String(sent["text"])).toContain('skill "real-sfx"')
    expect(String(sent["text"])).toContain('skill "openverse"')
    expect(String(sent["text"])).toContain("(nenhum")
  })

  test("the video subject passes through to the skill", async () => {
    const prompts: Array<Record<string, unknown>> = []
    const session = {
      prompt: async (input: Record<string, unknown>) => {
        prompts.push(input)
        return undefined
      },
    }
    const command = buildVideoCommand(session as never)
    await command.execute({
      sessionID: "ses_video_command_args",
      prompt: { text: "tour da tela inicial" },
      delivery: "steer",
    } as never)
    expect(prompts[0]?.["skills"]).toEqual([{ id: "hyperframes" }, { id: "real-sfx" }, { id: "openverse" }])
    expect(String(prompts[0]?.["text"])).toContain("tour da tela inicial")
  })
})
