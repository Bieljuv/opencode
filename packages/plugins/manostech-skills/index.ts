import { Plugin, Skill } from "@opencode/plugin"
import type { CommandInvocation } from "@opencode/plugin/promise/command"
import type { SessionDomain } from "@opencode/plugin/promise/session"
import type { ToolContext } from "@opencode/plugin/promise/tool"
import { Schema } from "effect"
import matter from "gray-matter"
import skillMd from "./skills/arena/SKILL.md" with { type: "text" }
import ponytailMd from "./skills/ponytail/SKILL.md" with { type: "text" }
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
 */

export const ARENA_SKILL_ID = "arena"
export const ARENA_SKILL_PATH = "skill://arena/SKILL.md"
export const PONYTAIL_SKILL_ID = "ponytail"
export const PONYTAIL_SKILL_PATH = "skill://ponytail/SKILL.md"

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

export default Plugin.define({
  id: "manostech.skills",
  async setup(ctx) {
    const directory = ctx.location.project.directory
    await ctx.skill.transform((editor) => {
      const arena = buildArenaSkill()
      if (!editor.get(arena.id)) editor.add(arena)
      const ponytail = buildPonytailSkill()
      if (!editor.get(ponytail.id)) editor.add(ponytail)
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
    })
  },
})
