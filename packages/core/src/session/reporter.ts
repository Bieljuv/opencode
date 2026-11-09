export * as SessionReporter from "./reporter.js"

import { Effect } from "effect"
import type { SessionUsage } from "./usage.js"

/**
 * ManosTech: envia um evento de uso por passo de IA concluído ao Painel
 * Gerenciador (POST /api/ingest). Fail-open por desenho: sem segredo, sem
 * arquivo de identidade, sem uso ou com o painel fora do ar, não envia
 * nada e nunca falha o passo. A primeira vez que falta configuração,
 * identidade ou uso, o motivo fica registrado em nível informativo
 * (só o código do motivo, nunca valores), para aparecer no
 * "Exportar logs". A identidade do cliente (client_id/client_email)
 * chega pelo arquivo que o app desktop escreve em cada login/logout; o
 * segredo de envio chega por variável de ambiente no processo do servidor.
 *
 * Nada do que vai para o painel aparece para o usuário: o modelo é
 * registrado só no painel, nunca na interface.
 */

export const PANEL_INGEST_URL = "https://painel-manostech.manostech.workers.dev/api/ingest"

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
  readonly tokens_in: number
  readonly tokens_out: number
  readonly cost_usd: number
}

/** O que o repórter precisa do ambiente; ausente significa "desligado". */
export type Config = {
  readonly url: string
  readonly secret: string
  readonly clientFile: string
}

export function resolveConfig(env: Record<string, string | undefined>): Config | undefined {
  const secret = env.MANOSTECH_INGEST_SECRET
  const clientFile = env.MANOSTECH_CLIENT_FILE

  if (!secret || !clientFile) return undefined

  return {
    url: env.MANOSTECH_INGEST_URL ?? PANEL_INGEST_URL,
    secret,
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
 * saída e raciocínio. Um passo sem uso nenhum não gera evento.
 */
export function buildEvent(input: {
  readonly model: string
  readonly tokens: SessionUsage.Recorded["tokens"]
  readonly cost: number
  readonly client: ClientIdentity
}): IngestEvent | undefined {
  const tokensIn = input.tokens.input + input.tokens.cache.read + input.tokens.cache.write
  const tokensOut = input.tokens.output + input.tokens.reasoning

  if (tokensIn === 0 && tokensOut === 0 && input.cost === 0) return undefined

  return {
    client_id: input.client.client_id,
    client_email: input.client.client_email,
    origin: "desktop",
    model: input.model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: input.cost,
  }
}

/**
 * O motivo pelo qual o repórter está desligado — só o código, nunca
 * valores (sem segredo, token, chave ou identidade no log).
 */
export type SkipReason = "sem segredo" | "sem arquivo de identidade" | "sem uso"

/**
 * O motivo da falta de configuração, quando ela falta. Sem segredo de
 * envio, o repórter nem sabe para onde mandar; sem o caminho do arquivo
 * de identidade, não sabe de quem é o uso.
 */
export function configSkipReason(env: Record<string, string | undefined>): SkipReason | undefined {
  if (!env.MANOSTECH_INGEST_SECRET) return "sem segredo"
  if (!env.MANOSTECH_CLIENT_FILE) return "sem arquivo de identidade"
  return undefined
}

/**
 * Cada motivo é registrado uma única vez por processo, em nível
 * informativo — o suficiente para aparecer no "Exportar logs" sem
 * encher o arquivo a cada passo.
 */
const loggedSkipReasons = new Set<SkipReason>()

function logSkippedOnce(reason: SkipReason) {
  if (loggedSkipReasons.has(reason)) return Effect.void
  loggedSkipReasons.add(reason)
  return Effect.logInfo("relatório de uso desligado", { motivo: reason })
}

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
          authorization: `Bearer ${config.secret}`,
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

/**
 * Envia o evento de um passo concluído. Nunca falha: qualquer problema
 * (sem configuração, sem identidade, painel fora do ar) vira silêncio
 * no passo — mas a primeira vez que falta configuração, identidade ou
 * uso, o motivo fica registrado em nível informativo, para aparecer no
 * "Exportar logs". Quem chama dispara com `Effect.forkDetach` para o
 * passo não esperar.
 */
export function report(input: {
  readonly model: string
  readonly tokens: SessionUsage.Recorded["tokens"]
  readonly cost: SessionUsage.Recorded["cost"]
}): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const config = resolveConfig(process.env)

    if (!config) {
      yield* logSkippedOnce(configSkipReason(process.env) ?? "sem segredo")
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
