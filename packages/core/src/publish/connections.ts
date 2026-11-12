export * as PublishConnections from "./connections.js"

/**
 * As conexões da conta do cliente (GitHub, Vercel, Supabase) no guia
 * /publicar. O aplicativo desktop passa o estado de cada uma como
 * variável de ambiente quando inicia o servidor — só conectado e nome
 * da conta, nunca o token. Sem o aplicativo (web, TUI), o guia não fala
 * de conexões e o fluxo segue como antes.
 */

export const PUBLISH_CONNECTION_PROVIDERS = ["github", "vercel", "supabase"] as const

export type PublishConnectionProvider = (typeof PUBLISH_CONNECTION_PROVIDERS)[number]

export interface PublishConnectionStatus {
  readonly provider: PublishConnectionProvider
  readonly connected: boolean
  readonly login?: string
}

export interface PublishConnectionsStatus {
  /** O app desktop passa as conexões; sem ele, o guia não fala delas. */
  readonly available: boolean
  readonly github: PublishConnectionStatus
  readonly vercel: PublishConnectionStatus
  readonly supabase: PublishConnectionStatus
}

export function readPublishConnections(env: NodeJS.ProcessEnv): PublishConnectionsStatus {
  const available = env.MANOSTECH_CONNECTIONS_AVAILABLE === "1"

  return {
    available,
    github: readConnection(env, "github"),
    vercel: readConnection(env, "vercel"),
    supabase: readConnection(env, "supabase"),
  }
}

function readConnection(env: NodeJS.ProcessEnv, provider: PublishConnectionProvider): PublishConnectionStatus {
  const key = provider.toUpperCase()
  const connected = env[`MANOSTECH_CONN_${key}_CONNECTED`] === "1"
  const login = env[`MANOSTECH_CONN_${key}_LOGIN`]
  const status: PublishConnectionStatus = { provider, connected }

  return typeof login === "string" && login.length > 0 ? { ...status, login } : status
}

/**
 * A seção que o comando /publicar injeta no guia, ou vazio quando o
 * servidor não recebeu as conexões (web, TUI). O nome da conexão aparece
 * aqui de propósito: sem ele o cliente não saberia onde conectar o que
 * falta (ordem do Gabriel, 2026-11-12 — revoga, só neste ponto, a regra
 * de 2026-11-11 de nunca escrever o nome de um conector no guia).
 */
export function formatPublishConnectionsBlock(status: PublishConnectionsStatus): string {
  if (!status.available) return ""

  const lines = PUBLISH_CONNECTION_PROVIDERS.map((provider) => {
    const connection = status[provider]
    const name = provider === "github" ? "GitHub" : provider === "vercel" ? "Vercel" : "Supabase"

    return `- ${name}: ${connection.connected ? `conectado${connection.login ? ` como ${connection.login}` : ""}` : "não conectado"}`
  })

  return [
    "## Conexões da conta do cliente",
    "",
    'O aplicativo já sabe quais contas o cliente conectou para publicar (na barra lateral, seção "Conexões"):',
    ...lines,
    "",
    'Quando um passo precisar de uma conexão que falta, diga em linguagem simples qual falta e que o cliente conecta ela na barra lateral, seção "Conexões", antes de continuar — não avance o passo sem ela. Quando a conexão existe, o passo continua guiado, passo a passo, como antes: nesta versão o aplicativo ainda não envia nada sozinho pela conexão; o cliente faz cada ação na conta dele, com você guiando.',
  ].join("\n")
}
