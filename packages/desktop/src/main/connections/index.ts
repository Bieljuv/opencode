import { getStore, type SettingsStore } from "../storage/store"
import {
  clearConnection,
  loadAllConnectionStatuses,
  loadConnectionStatus,
  loadConnectionToken,
  saveConnectionLogin,
  saveConnectionPermission,
  saveConnectionToken,
  type ConnectionPermission,
  type ConnectionProvider,
  type ConnectionStatus,
} from "./store"
import { testConnection } from "./validate"

/**
 * ManosTech: as conexões da conta do cliente, no processo principal.
 * O renderer pede e o main executa: o token nunca cruza o IPC de volta,
 * e o servidor só recebe o estado (conectado + nome da conta) como
 * variável de ambiente no próximo início do serviço. O `envChanged` de
 * cada resultado diz ao handler quando o ambiente do servidor mudou — é
 * ele quem pede o reinício do serviço e avisa as janelas (a mesma ponte
 * do login), porque este módulo não toca no Electron e segue testável.
 */

export type SaveConnectionResult =
  | { readonly ok: true; readonly login?: string; readonly envChanged: boolean }
  | { readonly ok: false }

export type TestConnectionResult =
  | { readonly ok: true; readonly login?: string; readonly envChanged: boolean }
  | { readonly ok: false }

export function getConnectionStatuses(store: SettingsStore = getStore()): ConnectionStatus[] {
  return loadAllConnectionStatuses(store)
}

/**
 * Conectar = validar primeiro, guardar depois: um token rejeitado pelo
 * provedor nunca é guardado, então "conectado" na barra lateral sempre
 * significa um token que já foi aceito ao menos uma vez. Sem rede ou com
 * o token inválido, nada muda e o painel mostra o erro em linguagem
 * simples.
 */
export async function saveConnection(
  store: SettingsStore,
  provider: ConnectionProvider,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SaveConnectionResult> {
  const trimmed = token.trim()

  if (trimmed.length === 0) return { ok: false }

  const before = loadConnectionStatus(store, provider)
  const result = await testConnection(provider, trimmed, fetchImpl)

  if (!result.ok) return { ok: false }

  saveConnectionToken(store, provider, trimmed)
  if (result.login) saveConnectionLogin(store, provider, result.login)

  return {
    ok: true,
    ...(result.login ? { login: result.login } : {}),
    envChanged: !before.connected || before.login !== result.login,
  }
}

/** Revalida o token guardado e atualiza o nome da conta quando ele muda. */
export async function testStoredConnection(
  store: SettingsStore,
  provider: ConnectionProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<TestConnectionResult> {
  const token = loadConnectionToken(store, provider)

  if (!token) return { ok: false }

  const before = loadConnectionStatus(store, provider)
  const result = await testConnection(provider, token, fetchImpl)

  if (!result.ok) return { ok: false }

  if (result.login) saveConnectionLogin(store, provider, result.login)

  return {
    ok: true,
    ...(result.login ? { login: result.login } : {}),
    envChanged: before.login !== result.login,
  }
}

/** Desconectar apaga o token e avisa o servidor no próximo início. */
export function disconnectConnection(
  store: SettingsStore,
  provider: ConnectionProvider,
): { readonly envChanged: boolean } {
  const before = loadConnectionStatus(store, provider)

  clearConnection(store, provider)

  return { envChanged: before.connected }
}

/**
 * A permissão é guardada e mostrada; a execução (enviar o projeto,
 * publicar) ainda não existe nesta frente, então nada a impõe por
 * enquanto — ver a ressalva honesta no corpo da PR.
 */
export function setConnectionPermission(
  store: SettingsStore,
  provider: ConnectionProvider,
  permission: ConnectionPermission,
): void {
  saveConnectionPermission(store, provider, permission)
}
