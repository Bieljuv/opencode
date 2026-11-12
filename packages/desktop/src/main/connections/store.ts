import { decryptSecret, encryptSecret, type SecretBackend } from "../client-auth/secrets"
import type { SettingsStore } from "../storage/store"

/**
 * ManosTech: as conexões da conta do cliente (GitHub, Vercel, Supabase)
 * para publicar o projeto dele. O token de cada uma vive no
 * `opencode.settings` do processo principal, criptografado com o
 * `safeStorage` (o mesmo mecanismo da chave API do cliente) — o renderer
 * nunca vê o token, o projeto nunca o recebe, e nenhum log o registra.
 * O status que cruza o IPC é só conectado/desconectado, o nome da conta
 * e a permissão — nunca o token.
 */

export const CONNECTION_PROVIDERS = ["github", "vercel", "supabase"] as const

export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number]

export const CONNECTION_PERMISSIONS = ["allow", "ask", "block"] as const

export type ConnectionPermission = (typeof CONNECTION_PERMISSIONS)[number]

export const DEFAULT_CONNECTION_PERMISSION: ConnectionPermission = "ask"

export interface ConnectionStatus {
  readonly provider: ConnectionProvider
  readonly connected: boolean
  /** Nome da conta no provedor, quando o teste já o descobriu. */
  readonly login?: string
  readonly permission: ConnectionPermission
}

export function connectionTokenKey(provider: ConnectionProvider): string {
  return `manostech.conn.${provider}.token`
}

export function connectionLoginKey(provider: ConnectionProvider): string {
  return `manostech.conn.${provider}.login`
}

export function connectionPermissionKey(provider: ConnectionProvider): string {
  return `manostech.conn.${provider}.permission`
}

function isPermission(value: string): value is ConnectionPermission {
  return (CONNECTION_PERMISSIONS as readonly string[]).includes(value)
}

/**
 * Guarda o token (criptografado) e esquece o nome da conta: um token novo
 * ainda não foi validado, e o nome só volta no próximo teste bem-sucedido.
 */
export function saveConnectionToken(
  store: SettingsStore,
  provider: ConnectionProvider,
  token: string,
  backend?: SecretBackend,
): void {
  store.set(connectionTokenKey(provider), encryptSecret(token, backend))
  store.delete(connectionLoginKey(provider))
}

export function loadConnectionToken(
  store: SettingsStore,
  provider: ConnectionProvider,
  backend?: SecretBackend,
): string | undefined {
  const current = store.get(connectionTokenKey(provider))

  if (typeof current !== "string" || current.length === 0) return undefined

  const token = decryptSecret(current, backend)

  return token !== undefined && token.length > 0 ? token : undefined
}

export function saveConnectionLogin(store: SettingsStore, provider: ConnectionProvider, login: string): void {
  store.set(connectionLoginKey(provider), login)
}

export function saveConnectionPermission(
  store: SettingsStore,
  provider: ConnectionProvider,
  permission: ConnectionPermission,
): void {
  store.set(connectionPermissionKey(provider), permission)
}

export function loadConnectionPermission(store: SettingsStore, provider: ConnectionProvider): ConnectionPermission {
  const current = store.get(connectionPermissionKey(provider))

  return typeof current === "string" && isPermission(current) ? current : DEFAULT_CONNECTION_PERMISSION
}

export function loadConnectionStatus(
  store: SettingsStore,
  provider: ConnectionProvider,
  backend?: SecretBackend,
): ConnectionStatus {
  const login = store.get(connectionLoginKey(provider))
  const status: ConnectionStatus = {
    provider,
    connected: loadConnectionToken(store, provider, backend) !== undefined,
    permission: loadConnectionPermission(store, provider),
  }

  return typeof login === "string" && login.length > 0 ? { ...status, login } : status
}

export function loadAllConnectionStatuses(store: SettingsStore, backend?: SecretBackend): ConnectionStatus[] {
  return CONNECTION_PROVIDERS.map((provider) => loadConnectionStatus(store, provider, backend))
}

/** Desconectar apaga tudo: token, nome da conta e permissão volta ao padrão. */
export function clearConnection(store: SettingsStore, provider: ConnectionProvider): void {
  store.delete(connectionTokenKey(provider))
  store.delete(connectionLoginKey(provider))
  store.delete(connectionPermissionKey(provider))
}

/** O servidor só precisa saber se a conexão existe e como chamar a conta. */
export function connectionServerEnv(statuses: readonly ConnectionStatus[]): Record<string, string> {
  const env: Record<string, string> = { MANOSTECH_CONNECTIONS_AVAILABLE: "1" }

  for (const status of statuses) {
    if (!status.connected) continue
    env[`MANOSTECH_CONN_${status.provider.toUpperCase()}_CONNECTED`] = "1"
    if (status.login) env[`MANOSTECH_CONN_${status.provider.toUpperCase()}_LOGIN`] = status.login
  }

  return env
}
