import { createMemo, createSignal } from "solid-js"
import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"
import type { SessionDocument } from "../document"
import { SessionTimeline } from "./session-timeline"
import { CurrentSessionProviders } from "../storybook/current-session-story"
import { CURRENT_SESSION_ID, STORY_MODEL, STORY_TIME } from "../storybook/current-session-fixtures"

export default {
  title: "OpenCode/Conversation/Long assistant replies",
  id: "assistant-text-fold",
  parameters: { layout: "fullscreen" },
  render: () => <LongAssistantReplies />,
}

export const Thread = {}

export const Streaming = {
  render: () => <StreamingLongReply />,
}

function LongAssistantReplies() {
  return (
    <section data-story="assistant-text-fold" class="mx-auto w-full max-w-[760px] px-6 py-8">
      <CurrentSessionProviders document={thread}>
        <SessionTimeline document={thread} />
      </CurrentSessionProviders>
    </section>
  )
}

function StreamingLongReply() {
  const [completed, setCompleted] = createSignal(false)

  const document = createMemo(
    (): SessionDocument => ({
      sessionID: CURRENT_SESSION_ID,
      status: { type: completed() ? "idle" : "busy" },
      diffs: [],
      messages: [
        user("msg_stream_user", "Show me the plan before you build anything."),
        {
          id: "msg_stream_reply",
          type: "assistant",
          agent: "build",
          model: STORY_MODEL,
          time: { created: STORY_TIME + 100, completed: completed() ? STORY_TIME + 1000 : undefined },
          content: [
            {
              type: "text",
              text: plan,
              native: completed() ? undefined : { phase: "streaming" },
            },
          ],
        },
      ],
    }),
  )

  return (
    <section class="mx-auto flex w-full max-w-[760px] flex-col gap-4 px-6 py-8">
      <button type="button" onClick={() => setCompleted((value) => !value)}>
        {completed() ? "Stream response" : "Complete response"}
      </button>
      <CurrentSessionProviders document={document()}>
        <SessionTimeline document={document()} />
      </CurrentSessionProviders>
    </section>
  )
}

let offset = 0

function user(id: string, text: string): SessionMessageUser {
  offset += 60_000

  return {
    id,
    type: "user",
    text,
    time: { created: STORY_TIME + offset },
    metadata: { agent: "build", model: STORY_MODEL },
  }
}

function reply(id: string, text: string): SessionMessageAssistant {
  offset += 20_000

  return {
    id,
    type: "assistant",
    agent: "build",
    model: STORY_MODEL,
    content: [{ type: "text", text }],
    time: { created: STORY_TIME + offset, completed: STORY_TIME + offset + 9_000 },
  }
}

const plan = [
  "## Plano — Sistema de gestão para comércio",
  "",
  "### O que será construído",
  "- Cadastro de produtos e estoque, com alerta de estoque baixo.",
  "- Cadastro de clientes e registro de vendas e pedidos.",
  "- Painel com vendas do dia e produtos mais vendidos.",
  "",
  "### Banco de dados",
  "- Tabelas no Supabase com o SQL versionado no projeto.",
  "- Políticas de acesso por empresa, sem segredos no código.",
  "",
  "### Plataformas",
  "- Web: painel principal em Next.js.",
  "- Desktop: app instalado no PC, conectado à nuvem.",
  "- Mobile: versão responsiva para consulta rápida e vendas em campo.",
  "",
  "### Etapas",
  "1. Esquema do banco e login multiempresa.",
  "2. Telas de produtos, clientes e vendas.",
  "3. Integração desktop e ajustes mobile.",
  "4. README com execução e publicação.",
  "",
  "Recursos avançados como emissão fiscal e pagamento ficam para a próxima etapa.",
].join("\n")

const thread = {
  sessionID: CURRENT_SESSION_ID,
  status: { type: "idle" },
  diffs: [],
  messages: [
    user("msg_reply_short_user", "Did the tests pass?"),
    reply("msg_reply_short_reply", "All 214 desktop tests pass."),
    user("msg_plan_user", "Show me the plan before you build anything."),
    reply("msg_plan_reply", plan),
  ] satisfies SessionMessageInfo[],
} satisfies SessionDocument
