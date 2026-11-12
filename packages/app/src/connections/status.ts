import { createSignal, onCleanup } from "solid-js"
import type { Platform } from "@/runtime/platform/platform"
import type { ConnectionStatus } from "./connections"

/**
 * O estado das conexões para a barra lateral: carrega uma vez, mostra
 * bolinha cinza até a primeira resposta e recarrega quando o processo
 * principal avisa que algo mudou. É um sinal comum — não um recurso que
 * suspende: a barra nunca pisca nem some enquanto carrega. Sem os
 * métodos do aplicativo de computador, nasce vazio e fica vazio.
 */
export function createConnectionsStatus(
  platform: Pick<Platform, "getConnectionsStatus" | "onConnectionsChanged">,
) {
  const [statuses, setStatuses] = createSignal<readonly ConnectionStatus[] | undefined>(undefined)

  const load = () => {
    if (!platform.getConnectionsStatus) return
    void platform
      .getConnectionsStatus()
      .then((next) => setStatuses(next))
      .catch(() => undefined)
  }

  load()
  const unsubscribe = platform.onConnectionsChanged?.(() => load())
  onCleanup(() => unsubscribe?.())

  return {
    statuses,
    loaded: () => statuses() !== undefined,
    statusOf: (provider: ConnectionStatus["provider"]) => statuses()?.find((item) => item.provider === provider),
  }
}

export type ConnectionsStatusSource = ReturnType<typeof createConnectionsStatus>
