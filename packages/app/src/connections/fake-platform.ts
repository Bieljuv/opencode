import { createStore } from "solid-js/store"
import type { Platform } from "@/runtime/platform/platform"
import type { ConnectionStatus } from "./connections"

/**
 * A plataforma falsa das stories: guarda as conexões em memória e valida
 * o token como o processo principal faria — token vazio ou começado por
 * "bad" é rejeitado; os demais são aceitos (GitHub e Vercel devolvem o
 * nome da conta "usuario-teste"; o Supabase conecta sem nome, como a API
 * dele). Só para as stories; nada aqui toca rede nem disco.
 */
export function createFakeConnectionsPlatform(initial: ConnectionStatus[]): Platform {
  const [state, setState] = createStore<{ statuses: ConnectionStatus[] }>({ statuses: initial })
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((callback) => callback())

  return {
    platform: "desktop",
    windowID: "story",
    openExternal: () => {},
    openDirectoryPickerDialog: async () => null,
    restart: async () => {},
    notify: async () => {},
    fetch: globalThis.fetch.bind(globalThis),
    getConnectionsStatus: async () => state.statuses.map((status) => ({ ...status })),
    saveConnectionToken: async (provider, token) => {
      if (token.trim().length === 0 || token.startsWith("bad")) return { ok: false as const }
      const login = provider === "supabase" ? undefined : "usuario-teste"
      setState(
        "statuses",
        state.statuses.map((status) =>
          status.provider === provider
            ? { provider, connected: true, ...(login ? { login } : {}), permission: status.permission }
            : status,
        ),
      )
      notify()
      return login ? { ok: true as const, login } : { ok: true as const }
    },
    testConnection: async (provider) => {
      const status = state.statuses.find((item) => item.provider === provider)
      if (!status?.connected) return { ok: false as const }
      return status.login ? { ok: true as const, login: status.login } : { ok: true as const }
    },
    disconnectConnection: async (provider) => {
      setState(
        "statuses",
        state.statuses.map((status) =>
          status.provider === provider ? { provider, connected: false, permission: "ask" } : status,
        ),
      )
      notify()
    },
    setConnectionPermission: async (provider, permission) => {
      setState(
        "statuses",
        state.statuses.map((status) => (status.provider === provider ? { ...status, permission } : status)),
      )
      notify()
    },
    onConnectionsChanged: (callback) => {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
  }
}
