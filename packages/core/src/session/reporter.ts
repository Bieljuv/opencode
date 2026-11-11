export * as SessionReporter from "./reporter.js"

import { Effect } from "effect"
import type { SessionUsage } from "./usage.js"

/**
 * ManosTech: envia um evento de uso por passo de IA concluído ao Painel
 * Gerenciador (POST /api/ingest). Fail-open por desenho: sem chave do
 * cliente, sem arquivo de identidade, sem uso ou com o painel fora do
 * ar, não envia nada e nunca falha o passo. A primeira vez que falta
 * configuração, identidade ou uso, o motivo fica registrado em nível
 * informativo (só o código do motivo, nunca valores), para aparecer no
 * "Exportar logs". A identidade do cliente (client_id/client_email)
 * chega pelo arquivo que o app desktop escreve em cada login/logout; a
 * chave API do cliente chega por variável de ambiente no processo do
 * servidor — o main a lê do store criptografado e a entrega ao sidecar
 * no lançamento. Nenhum segredo compartilhado vai para o instalador:
 * a ingestão autentica com a chave do próprio cliente (mtk_...), e o
 * painel rejeita o evento quando o client_id do corpo não é o da chave.
 *
 * Nada do que vai para o painel aparece para o usuário: o modelo é
 * registrado só no painel, nunca na interface.
 *
 * Quem reporta o quê (auditoria C5 — nunca os dois para a mesma
 * chamada): o gateway grava direto no painel o uso das chamadas que
 * passam por ele, então o repórter SÓ mede o uso direto, fora do
 * gateway — um passo servido pelo modelo do gateway não gera evento.
 * Cada evento carrega um `event_id` (UUID) para a ingestão deduplicar
 * a repetição do mesmo evento.
 */

export const PANEL_INGEST_URL = "https://painel-manostech.manostech.workers.dev/api/ingest"

/** O modelo do gateway (`providerID/modelID`): o repórter não o envia. */
export const GATEWAY_MODEL_ID = "manostech/auto"

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const SEND_TIMEOUT_MS = 5_000

export type ClientIdentity = {
  readonly client_id: string
  readonly client_email: string
}

export type IngestEvent = {
  readonly client_id: string
  readonly client_email: string
  readonly origin: "desktop"
  readonly model: string
  readonly event_id: string
  readonly tokens_in: number
  readonly tokens_out: number
  readonly cost_usd: number
}

/** O que o repórter precisa do ambiente; ausente significa "desligado". */
export type Config = {
  readonly url: string
  readonly apiKey: string
  readonly clientFile: string
}

export function resolveConfig(env: Record<string, string | undefined>): Config | undefined {
  const apiKey = env.MANOSTECH_INGEST_API_KEY
  const clientFile = env.MANOSTECH_CLIENT_FILE

  if (!apiKey || !clientFile) return undefined

  return {
    url: env.MANOSTECH_INGEST_URL ?? PANEL_INGEST_URL,
    apiKey,
    clientFile,
  }
}

/** Valida o arquivo de identidade uma única vez, na borda. */
export function parseClientIdentity(text: string): ClientIdentity | undefined {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()

  if (typeof parsed !== "object" || parsed === null) return undefined

  const clientId = (parsed as Record<string, unknown>).client_id
  const clientEmail = (parsed as Record<string, unknown>).client_email

  if (typeof clientId !== "string" || clientId.length === 0) return undefined
  if (typeof clientEmail !== "string" || !EMAIL_PATTERN.test(clientEmail)) return undefined

  return { client_id: clientId, client_email: clientEmail.toLowerCase() }
}

/**
 * Monta o evento do painel a partir do uso do passo. `tokens_in` soma tudo
 * que entra (inclui cache, que é cobrado como entrada); `tokens_out` soma
 * saída e raciocínio. Um passo sem uso nenhum não gera evento. Um passo
 * servido pelo gateway também não gera evento — o gateway já mediu essa
 * chamada e o painel grava direto; enviar de novo contaria duas vezes.
 */
export function buildEvent(input: {
  readonly model: string
  readonly tokens: SessionUsage.Recorded["tokens"]
  readonly cost: number
  readonly client: ClientIdentity
}): IngestEvent | undefined {
  if (input.model === GATEWAY_MODEL_ID) return undefined

  const tokensIn = input.tokens.input + input.tokens.cache.read + input.tokens.cache.write
  const tokensOut = input.tokens.output + input.tokens.reasoning

  if (tokensIn === 0 && tokensOut === 0 && input.cost === 0) return undefined

  return {
    client_id: input.client.client_id,
    client_email: input.client.client_email,
    origin: "desktop",
    model: input.model,
    event_id: crypto.randomUUID(),
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: input.cost,
  }
}

/**
 * O motivo pelo qual o repórter está desligado — só o código, nunca
 * valores (sem segredo, token, chave ou identidade no log).
 */
export type SkipReason = "sem chave do cliente" | "sem arquivo de identidade" | "sem uso"

/**
 * O motivo da falta de configuração, quando ela falta. Sem a chave do
 * cliente, o repórter nem sabe com o que autenticar; sem o caminho do
 * arquivo de identidade, não sabe de quem é o uso.
 */
export function configSkipReason(env: Record<string, string | undefined>): SkipReason | undefined {
  if (!env.MANOSTECH_INGEST_API_KEY) return "sem chave do cliente"
  if (!env.MANOSTECH_CLIENT_FILE) return "sem arquivo de identidade"
  return undefined
}

/**
 * Cria um repórter com o seu próprio registro de motivos já avisados.
 * Cada motivo é registrado uma única vez por repórter, em nível
 * informativo — o suficiente para aparecer no "Exportar logs" sem
 * encher o arquivo a cada passo.
 */
export function makeReporter() {
  const loggedSkipReasons = new Set<SkipReason>()

  function logSkippedOnce(reason: SkipReason) {
    if (loggedSkipReasons.has(reason)) return Effect.void
    loggedSkipReasons.add(reason)
    return Effect.logInfo("relatório de uso desligado", { motivo: reason })
  }

  /**
   * Envia o evento de um passo concluído. Nunca falha: qualquer problema
   * (sem configuração, sem identidade, painel fora do ar) vira silêncio
   * no passo — mas a primeira vez que falta configuração, identidade ou
   * uso, o motivo fica registrado em nível informativo, para aparecer no
   * "Exportar logs". Quem chama dispara com `Effect.forkDetach` para o
   * passo não esperar.
   */
  function report(input: {
    readonly model: string
    readonly tokens: SessionUsage.Recorded["tokens"]
    readonly cost: SessionUsage.Recorded["cost"]
  }): Effect.Effect<void, never, never> {
    return Effect.gen(function* () {
      const config = resolveConfig(process.env)

      if (!config) {
        yield* logSkippedOnce(configSkipReason(process.env) ?? "sem chave do cliente")
        return
      }

      const client = yield* readIdentity(config.clientFile)

      if (!client) {
        yield* logSkippedOnce("sem arquivo de identidade")
        return
      }

      const event = buildEvent({ model: input.model, tokens: input.tokens, cost: Number(input.cost), client })

      if (!event) {
        yield* logSkippedOnce("sem uso")
        return
      }

      yield* sendEvent(config, event)
    }).pipe(
      Effect.catchCause(() => Effect.logDebug("usage report skipped")),
      Effect.asVoid,
    )
  }

  return { report }
}

/**
 * O repórter do processo: uma instância só, então cada motivo aparece no
 * máximo uma vez por processo.
 */
export const report = makeReporter().report

function readIdentity(file: string) {
  return Effect.tryPromise({
    try: () => Bun.file(file).text(),
    catch: () => undefined,
  }).pipe(
    Effect.map((text) => (text === undefined ? undefined : parseClientIdentity(text))),
    Effect.catch(() => Effect.succeed(undefined)),
  )
}

function sendEvent(config: Config, event: IngestEvent) {
  return Effect.tryPromise({
    try: () =>
      fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + config.apiKey,
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }),
    catch: () => undefined,
  }).pipe(
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  )
}
