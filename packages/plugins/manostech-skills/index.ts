import { Plugin, Skill } from "@opencode/plugin"
import type { CommandInvocation } from "@opencode/plugin/promise/command"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Schema } from "effect"
import matter from "gray-matter"
import skillMd from "./skills/arena/SKILL.md" with { type: "text" }
import graphifyMd from "./skills/graphify/SKILL.md" with { type: "text" }
import hyperframesMd from "./skills/hyperframes/SKILL.md" with { type: "text" }
import openverseMd from "./skills/openverse/SKILL.md" with { type: "text" }
import ponytailMd from "./skills/ponytail/SKILL.md" with { type: "text" }
import realSfxMd from "./skills/real-sfx/SKILL.md" with { type: "text" }
import { runArena } from "./src/bracket.ts"

/**
 * ManosTech skills, as a built-in plugin.
 *
 * Arena: the tournament skill, the `arena` tool and the `/arena` command are
 * always available: the tournament only runs when the user asks for it (or
 * accepts the offer), and the winning solution is proposed, never applied.
 * The bracket state machine runs in process through `runArena` — no shell,
 * no Python — and every run lives in `.arena/` inside the user's project.
 *
 * Ponytail: the lazy senior dev mode, as the `skill://ponytail` virtual skill
 * and the `/ponytail` command. The skill is always available and its
 * description matches any coding task, so the agent loads it on the first
 * coding turn and it stays active for the session; `/ponytail` switches the
 * level (lite/full/ultra, default full) or turns it off.
 *
 * Graphify: the project map, as the `skill://graphify` virtual skill and the
 * `/graphify` command. The skill is the upstream Graphify skill, byte for
 * byte except for the frontmatter (pt-BR triggers); it tells the agent to
 * build the map of the project (graphify-out/) with the graphify CLI when it
 * is installed and to consult the map before reading files. The map rule in
 * the system prompt makes consulting the map mandatory, and when the CLI is
 * not installed the agent builds a lightweight map with its own tools —
 * nobody is ever asked to install Python or anything else.
 *
 * Openverse: the open-license sound search, as the `skill://openverse`
 * virtual skill and the `/openverse` command. The skill is written here
 * (there is no upstream skill): it tells the agent to search the Openverse
 * audio API (api.openverse.org/v1/audio/) for a sound, effect, music or
 * ambience, pick the best result, download the direct file and record the
 * license and the attribution line. No key, no login, nothing to install.
 *
 * Real SFX: real sound on the exact video frame, as the `skill://real-sfx`
 * virtual skill and the `/real-sfx` command. The skill is adapted from the
 * upstream Real SFX skill (Clipwing, MIT): it keeps the rules, the moment
 * kinds, the levels and the taste rules, but the upstream's own Python
 * scripts are NOT bundled — the agent finds the moments (project cue list,
 * HyperFrames data-start timeline or frame analysis), picks real recordings
 * (user library or Openverse) and mixes them with FFmpeg directly. There is
 * no bundled sound library; when FFmpeg is not available the agent still
 * finds the moments and the sounds and leaves the exact mix commands ready,
 * without ever asking the user to install anything.
 *
 * HyperFrames: video as code, as the `skill://hyperframes` virtual skill.
 * There is no `/hyperframes` command of its own: the entry point is the
 * `/video` command, which loads hyperframes, real-sfx and openverse together
 * and runs the single flow — write the composition, check it, show the
 * preview for approval, render the MP4, add real sound, deliver the file
 * with a player page the preview opens beside the chat. The skill is adapted
 * from the workspace HyperFrames skill: it keeps the contract, the house
 * rules and the work cycle, but the environment section is rewritten for
 * this app — Node and FFmpeg come bundled with the installer (on the
 * server's PATH), never assumed from the user's machine, and the first
 * render still downloads the browser once.
 */

export const ARENA_SKILL_ID = "arena"
export const ARENA_SKILL_PATH = "skill://arena/SKILL.md"
export const GRAPHIFY_SKILL_ID = "graphify"
export const GRAPHIFY_SKILL_PATH = "skill://graphify/SKILL.md"
export const HYPERFRAMES_SKILL_ID = "hyperframes"
export const HYPERFRAMES_SKILL_PATH = "skill://hyperframes/SKILL.md"
export const OPENVERSE_SKILL_ID = "openverse"
export const OPENVERSE_SKILL_PATH = "skill://openverse/SKILL.md"
export const PONYTAIL_SKILL_ID = "ponytail"
export const PONYTAIL_SKILL_PATH = "skill://ponytail/SKILL.md"
export const REAL_SFX_SKILL_ID = "real-sfx"
export const REAL_SFX_SKILL_PATH = "skill://real-sfx/SKILL.md"

/** Commands that write under `.arena/` and therefore need edit permission first. */
const MUTATING_COMMANDS = new Set(["init", "prompts", "record", "collect", "advance"])

export function buildArenaSkill(): Skill.Info {
  const parsed = matter(skillMd)
  return Skill.Info.make({
    id: Skill.ID.make(ARENA_SKILL_ID),
    name: Skill.Name.make("Arena"),
    description: parsed.data.description,
    autoinvoke: parsed.data["disable-model-invocation"] !== true,
    path: Skill.Info.fields.path.make(ARENA_SKILL_PATH),
    content: parsed.content,
  })
}

export function buildPonytailSkill(): Skill.Info {
  const parsed = matter(ponytailMd)
  return Skill.Info.make({
    id: Skill.ID.make(PONYTAIL_SKILL_ID),
    name: Skill.Name.make("Ponytail"),
    description: parsed.data.description,
    autoinvoke: parsed.data["disable-model-invocation"] !== true,
    path: Skill.Info.fields.path.make(PONYTAIL_SKILL_PATH),
    content: parsed.content,
  })
}

export function buildGraphifySkill(): Skill.Info {
  const parsed = matter(graphifyMd)
  return Skill.Info.make({
    id: Skill.ID.make(GRAPHIFY_SKILL_ID),
    name: Skill.Name.make("Graphify"),
    description: parsed.data.description,
    autoinvoke: parsed.data["disable-model-invocation"] !== true,
    path: Skill.Info.fields.path.make(GRAPHIFY_SKILL_PATH),
    content: parsed.content,
  })
}

export function buildHyperframesSkill(): Skill.Info {
  const parsed = matter(hyperframesMd)
  return Skill.Info.make({
    id: Skill.ID.make(HYPERFRAMES_SKILL_ID),
    name: Skill.Name.make("HyperFrames"),
    description: parsed.data.description,
    autoinvoke: parsed.data["disable-model-invocation"] !== true,
    path: Skill.Info.fields.path.make(HYPERFRAMES_SKILL_PATH),
    content: parsed.content,
  })
}

export function buildOpenverseSkill(): Skill.Info {
  const parsed = matter(openverseMd)
  return Skill.Info.make({
    id: Skill.ID.make(OPENVERSE_SKILL_ID),
    name: Skill.Name.make("Openverse"),
    description: parsed.data.description,
    autoinvoke: parsed.data["disable-model-invocation"] !== true,
    path: Skill.Info.fields.path.make(OPENVERSE_SKILL_PATH),
    content: parsed.content,
  })
}

export function buildRealSfxSkill(): Skill.Info {
  const parsed = matter(realSfxMd)
  return Skill.Info.make({
    id: Skill.ID.make(REAL_SFX_SKILL_ID),
    name: Skill.Name.make("Real SFX"),
    description: parsed.data.description,
    autoinvoke: parsed.data["disable-model-invocation"] !== true,
    path: Skill.Info.fields.path.make(REAL_SFX_SKILL_PATH),
    content: parsed.content,
  })
}

export const ArenaToolInput = Schema.Struct({
  command: Schema.String.annotate({
    description:
      "Arena command: plan, init, next, prompts, check, pairings, record, collect, advance, status, winner or card.",
  }),
  args: Schema.Array(Schema.String).pipe(
    Schema.optional,
  ).annotate({ description: 'Arguments for the command, for example ["--agents", "20"].' }),
})
export type ArenaToolInput = typeof ArenaToolInput.Type

export const ArenaToolOutput = Schema.Struct({
  stdout: Schema.String,
  code: Schema.Number,
})
export type ArenaToolOutput = typeof ArenaToolOutput.Type

export interface ArenaToolDeps {
  /** The project directory the tournament runs in. */
  directory: string
  /** Asks the user for edit permission inside `.arena/`, like the write tool does. */
  assertEdit: (context: Pick<ToolContext, "sessionID" | "agent">) => Promise<void>
}

export function buildArenaTool(deps: ArenaToolDeps) {
  return {
    name: "arena",
    options: { codemode: false, permission: "edit" },
    description:
      "Executa os comandos do torneio Arena no projeto atual: planejar o tamanho, iniciar, avançar as rodadas e apurar a vencedora. O torneio acontece na pasta .arena do projeto.",
    input: ArenaToolInput,
    output: ArenaToolOutput,
    execute: async (input: ArenaToolInput, context: ToolContext) => {
      if (MUTATING_COMMANDS.has(input.command)) await deps.assertEdit(context)
      const result = await runArena([input.command, ...(input.args ?? [])], { cwd: deps.directory })
      return { output: { stdout: result.stdout, code: result.code }, content: result.stdout }
    },
  }
}

export function arenaCommandText(args: string): string {
  const trimmed = args.trim()
  return [
    "Execute a Arena com os argumentos abaixo. Primeiro carregue a skill \"arena\" com a ferramenta skill (id \"arena\") e siga as instruções dela à risca, sem pular passos.",
    "",
    `Argumentos: ${trimmed ? trimmed : "(nenhum — use a tarefa da conversa, como orienta a skill.)"}`,
  ].join("\n")
}

export function buildArenaCommand(session: Pick<SessionDomain, "prompt">) {
  return {
    name: "arena",
    description: "Arena: vários agentes competem pela mesma tarefa até sobrar a melhor resposta",
    execute: async (input: CommandInvocation) => {
      await session.prompt({
        ...input.prompt,
        sessionID: input.sessionID,
        text: arenaCommandText(input.prompt.text),
        skills: [{ id: ARENA_SKILL_ID }],
        delivery: input.delivery,
      })
    },
  }
}

export type PonytailLevel = "lite" | "full" | "ultra" | "off"

/** The level the user asked for: blank or unknown falls back to full, the default. */
export function ponytailLevel(args: string): PonytailLevel {
  const trimmed = args.trim().toLowerCase()
  if (trimmed === "off") return "off"
  if (trimmed === "lite") return "lite"
  if (trimmed === "ultra") return "ultra"
  return "full"
}

export function ponytailCommandText(args: string): string {
  const level = ponytailLevel(args)
  if (level === "off") {
    return "Desligue o modo ponytail desta sessão e volte ao modo normal. Não carregue a skill \"ponytail\" neste turno."
  }
  const keep =
    args.trim() === "" ? " Sem nível informado, mantenha o nível atual da sessão, ou ligue no padrão full se estava desligado." : ""
  return [
    `Ative o modo ponytail no nível ${level} para esta sessão. Primeiro carregue a skill "ponytail" com a ferramenta skill (id "ponytail") e siga as instruções dela à risca, sem pular passos.${keep}`,
    "",
    "Nível lite: construa o que foi pedido e nomeie a opção menor em uma linha. Nível full: as regras da skill. Nível ultra: questione o pedido antes de construir, além das regras da skill.",
  ].join("\n")
}

export function buildPonytailCommand(session: Pick<SessionDomain, "prompt">) {
  return {
    name: "ponytail",
    description: "Ponytail: o modo desenvolvedor preguiçoso — a menor mudança que resolve a tarefa",
    execute: async (input: CommandInvocation) => {
      const off = ponytailLevel(input.prompt.text) === "off"
      await session.prompt({
        ...input.prompt,
        sessionID: input.sessionID,
        text: ponytailCommandText(input.prompt.text),
        skills: off ? [] : [{ id: PONYTAIL_SKILL_ID }],
        delivery: input.delivery,
      })
    },
  }
}

export function graphifyCommandText(args: string): string {
  const trimmed = args.trim()
  return [
    "Construa ou consulte o mapa do projeto com a skill \"graphify\". Primeiro carregue a skill \"graphify\" com a ferramenta skill (id \"graphify\") e siga as instruções dela à risca, sem pular passos.",
    "",
    `Argumentos: ${trimmed ? trimmed : "(nenhum — diretório atual.)"}`,
  ].join("\n")
}

export function buildGraphifyCommand(session: Pick<SessionDomain, "prompt">) {
  return {
    name: "graphify",
    description: "Graphify: o mapa do projeto — consulte antes de ler os arquivos, construa quando não existir",
    execute: async (input: CommandInvocation) => {
      await session.prompt({
        ...input.prompt,
        sessionID: input.sessionID,
        text: graphifyCommandText(input.prompt.text),
        skills: [{ id: GRAPHIFY_SKILL_ID }],
        delivery: input.delivery,
      })
    },
  }
}

export function openverseCommandText(args: string): string {
  const trimmed = args.trim()
  return [
    "Ache um som com a skill \"openverse\". Primeiro carregue a skill \"openverse\" com a ferramenta skill (id \"openverse\") e siga as instruções dela à risca, sem pular passos.",
    "",
    `O que procurar: ${trimmed ? trimmed : "(nenhum — use o que a conversa pede.)"}`,
  ].join("\n")
}

export function buildOpenverseCommand(session: Pick<SessionDomain, "prompt">) {
  return {
    name: "openverse",
    description: "Openverse: acha sons, efeitos e músicas com licença aberta para o vídeo",
    execute: async (input: CommandInvocation) => {
      await session.prompt({
        ...input.prompt,
        sessionID: input.sessionID,
        text: openverseCommandText(input.prompt.text),
        skills: [{ id: OPENVERSE_SKILL_ID }],
        delivery: input.delivery,
      })
    },
  }
}

export function realSfxCommandText(args: string): string {
  const trimmed = args.trim()
  return [
    "Coloque som real no vídeo com a skill \"real-sfx\". Primeiro carregue a skill \"real-sfx\" com a ferramenta skill (id \"real-sfx\") e siga as instruções dela à risca, sem pular passos.",
    "",
    `Argumentos: ${trimmed ? trimmed : "(nenhum — use o vídeo da conversa.)"}`,
  ].join("\n")
}

export function buildRealSfxCommand(session: Pick<SessionDomain, "prompt">) {
  return {
    name: "real-sfx",
    description: "Real SFX: som real no frame exato do vídeo, mantendo música e voz",
    execute: async (input: CommandInvocation) => {
      await session.prompt({
        ...input.prompt,
        sessionID: input.sessionID,
        text: realSfxCommandText(input.prompt.text),
        skills: [{ id: REAL_SFX_SKILL_ID }],
        delivery: input.delivery,
      })
    },
  }
}

export function videoCommandText(args: string): string {
  const trimmed = args.trim()
  return [
    "Faça o vídeo do projeto com o fluxo único da skill \"hyperframes\": escreva a composição, confira com lint e check, mostre o preview para aprovar, renderize o MP4, sonorize com a skill \"real-sfx\" (sons pela skill \"openverse\") e entregue o arquivo com a página de exibição. Primeiro carregue as skills \"hyperframes\", \"real-sfx\" e \"openverse\" com a ferramenta skill e siga as instruções delas à risca, sem pular passos — a sonorização e a entrega fazem parte do fluxo, não são opcionais.",
    "",
    `O que o vídeo mostra: ${trimmed ? trimmed : "(nenhum — use o que a conversa pede.)"}`,
  ].join("\n")
}

export function buildVideoCommand(session: Pick<SessionDomain, "prompt">) {
  return {
    name: "video",
    description: "Vídeo: cria, sonoriza e entrega o vídeo do projeto — do roteiro ao arquivo pronto",
    execute: async (input: CommandInvocation) => {
      await session.prompt({
        ...input.prompt,
        sessionID: input.sessionID,
        text: videoCommandText(input.prompt.text),
        skills: [{ id: HYPERFRAMES_SKILL_ID }, { id: REAL_SFX_SKILL_ID }, { id: OPENVERSE_SKILL_ID }],
        delivery: input.delivery,
      })
    },
  }
}

export default Plugin.define({
  id: "manostech.skills",
  async setup(ctx) {
    const directory = ctx.location.project.directory
    await ctx.skill.transform((editor) => {
      const arena = buildArenaSkill()
      if (!editor.get(arena.id)) editor.add(arena)
      const ponytail = buildPonytailSkill()
      if (!editor.get(ponytail.id)) editor.add(ponytail)
      const graphify = buildGraphifySkill()
      if (!editor.get(graphify.id)) editor.add(graphify)
      const hyperframes = buildHyperframesSkill()
      if (!editor.get(hyperframes.id)) editor.add(hyperframes)
      const openverse = buildOpenverseSkill()
      if (!editor.get(openverse.id)) editor.add(openverse)
      const realSfx = buildRealSfxSkill()
      if (!editor.get(realSfx.id)) editor.add(realSfx)
    })
    await ctx.tool.transform((editor) => {
      if (editor.get("arena")) return
      editor.add(
        buildArenaTool({
          directory,
          assertEdit: (context) =>
            ctx.permission.assert({
              sessionID: context.sessionID,
              agent: context.agent,
              action: "edit",
              resources: [".arena/*"],
              save: [".arena/*"],
            }),
        }),
      )
    })
    await ctx.command.transform((editor) => {
      editor.add(buildArenaCommand(ctx.session))
      editor.add(buildPonytailCommand(ctx.session))
      editor.add(buildGraphifyCommand(ctx.session))
      editor.add(buildOpenverseCommand(ctx.session))
      editor.add(buildRealSfxCommand(ctx.session))
      editor.add(buildVideoCommand(ctx.session))
    })
  },
})
