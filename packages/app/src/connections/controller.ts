import { uuid } from "@opencode/util/uuid"
import { createSignal, onCleanup } from "solid-js"
import type { Platform } from "@/runtime/platform/platform"
import type { ConnectionPermission, ConnectionProvider } from "./connections"
import { initialConnectionsPanelState, transition, type ConnectionsPanelState } from "./machine"

/**
 * O driver do painel de conexões: a borda fina entre a máquina pura e o
 * mundo. Carrega o estado na abertura, inscreve-se nas mudanças vindas
 * do processo principal e transforma cada ação do usuário em: reivindicar
 * a operação na máquina ANTES do primeiro `await`, chamar a plataforma
 * e devolver o resultado como evento — com o id da tentativa. Todo
 * caminho assíncrono termina num estado: falha de rede ou RPC fora
 * vira o evento de falha do cartão, nunca um retorno silencioso.
 *
 * Sem os métodos do aplicativo de computador (na web o painel nem abre
 * — a barra lateral não mostra a seção), o painel nasce no erro de
 * carga e as ações não fazem nada.
 */

type ConnectionsPlatform = Pick<
  Platform,
  | "getConnectionsStatus"
  | "saveConnectionToken"
  | "testConnection"
  | "disconnectConnection"
  | "setConnectionPermission"
  | "onConnectionsChanged"
>

type ConnectionsMethods = {
  getConnectionsStatus: NonNullable<Platform["getConnectionsStatus"]>
  saveConnectionToken: NonNullable<Platform["saveConnectionToken"]>
  testConnection: NonNullable<Platform["testConnection"]>
  disconnectConnection: NonNullable<Platform["disconnectConnection"]>
  setConnectionPermission: NonNullable<Platform["setConnectionPermission"]>
  onConnectionsChanged: NonNullable<Platform["onConnectionsChanged"]>
}

function connectionMethods(platform: ConnectionsPlatform): ConnectionsMethods | undefined {
  if (
    !platform.getConnectionsStatus ||
    !platform.saveConnectionToken ||
    !platform.testConnection ||
    !platform.disconnectConnection ||
    !platform.setConnectionPermission ||
    !platform.onConnectionsChanged
  )
    return undefined

  return {
    getConnectionsStatus: platform.getConnectionsStatus,
    saveConnectionToken: platform.saveConnectionToken,
    testConnection: platform.testConnection,
    disconnectConnection: platform.disconnectConnection,
    setConnectionPermission: platform.setConnectionPermission,
    onConnectionsChanged: platform.onConnectionsChanged,
  }
}

export function createConnectionsPanel(platform: ConnectionsPlatform) {
  const methods = connectionMethods(platform)
  const [state, setState] = createSignal<ConnectionsPanelState>(
    methods ? initialConnectionsPanelState : { status: "load-failed" },
  )

  const dispatch = (event: Parameters<typeof transition>[1]) =>
    setState((current) => transition(current, event))

  onCleanup(() => dispatch({ type: "disposed" }))

  if (!methods) {
    return {
      state,
      save: () => undefined,
      test: () => undefined,
      disconnect: () => undefined,
      setPermission: () => undefined,
      retryLoad: () => dispatch({ type: "load-failed" }),
    }
  }

  const load = () => {
    void methods
      .getConnectionsStatus()
      .then((statuses) => dispatch({ type: "loaded", statuses }))
      .catch(() => dispatch({ type: "load-failed" }))
  }

  const refresh = () => {
    void methods
      .getConnectionsStatus()
      .then((statuses) => dispatch({ type: "refreshed", statuses }))
      .catch(() => undefined)
  }

  load()
  const unsubscribe = methods.onConnectionsChanged(() => refresh())
  onCleanup(() => unsubscribe())

  const save = (provider: ConnectionProvider, token: string) => {
    const attempt = uuid()
    dispatch({ type: "save-started", provider, attempt })
    void methods
      .saveConnectionToken(provider, token)
      .then((result) => {
        if (result.ok) {
          dispatch({ type: "saved", provider, attempt, ...(result.login ? { login: result.login } : {}) })
        } else {
          dispatch({ type: "save-failed", provider, attempt })
        }
        refresh()
      })
      .catch(() => {
        dispatch({ type: "save-failed", provider, attempt })
        refresh()
      })
  }

  const test = (provider: ConnectionProvider) => {
    const attempt = uuid()
    dispatch({ type: "test-started", provider, attempt })
    void methods
      .testConnection(provider)
      .then((result) => {
        if (result.ok) {
          dispatch({ type: "tested", provider, attempt, ...(result.login ? { login: result.login } : {}) })
        } else {
          dispatch({ type: "test-failed", provider, attempt })
        }
        refresh()
      })
      .catch(() => {
        dispatch({ type: "test-failed", provider, attempt })
        refresh()
      })
  }

  const disconnect = (provider: ConnectionProvider) => {
    const attempt = uuid()
    dispatch({ type: "disconnect-started", provider, attempt })
    void methods
      .disconnectConnection(provider)
      .then(() => {
        dispatch({ type: "disconnected", provider, attempt })
        refresh()
      })
      .catch(() => {
        dispatch({ type: "disconnect-failed", provider, attempt })
        refresh()
      })
  }

  const setPermission = (provider: ConnectionProvider, permission: ConnectionPermission) => {
    void methods
      .setConnectionPermission(provider, permission)
      .then(() => dispatch({ type: "permission-changed", provider, permission }))
      .catch(() => dispatch({ type: "permission-failed", provider }))
  }

  return {
    state,
    save,
    test,
    disconnect,
    setPermission,
    retryLoad: () => {
      dispatch({ type: "retry-load" })
      load()
    },
  }
}

export type ConnectionsPanelController = ReturnType<typeof createConnectionsPanel>
