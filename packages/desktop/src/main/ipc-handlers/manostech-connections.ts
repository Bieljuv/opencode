import { Effect } from "effect"
import { ManosTechConnectionsChanged } from "../../shared/ipc-rpc/events"
import { ManosTechConnectionsRpcs } from "../../shared/ipc-rpc"
import {
  disconnectConnection,
  getConnectionStatuses,
  saveConnection,
  setConnectionPermission,
  testStoredConnection,
} from "../connections"
import { emitIpcEvent } from "../ipc-events"
import { requestBackgroundServiceRestart } from "../service/background-service-restart"
import { getStore } from "../storage/store"
import { getMainWindows } from "../windows"

export const manosTechConnectionsHandlers = ManosTechConnectionsRpcs.toLayer(
  Effect.gen(function* () {
    return ManosTechConnectionsRpcs.of({
      ManosTechConnectionsStatus: () => promise(() => getConnectionStatuses(getStore())),
      ManosTechConnectionsSave: ({ provider, token }) =>
        promise(async () => {
          const result = await saveConnection(getStore(), provider, token)

          if (!result.ok) return { ok: false as const }
          notifyConnectionsChanged()
          if (result.envChanged) requestBackgroundServiceRestart()
          return result.login ? { ok: true as const, login: result.login } : { ok: true as const }
        }),
      ManosTechConnectionsTest: ({ provider }) =>
        promise(async () => {
          const result = await testStoredConnection(getStore(), provider)

          if (!result.ok) return { ok: false as const }
          if (result.envChanged) {
            notifyConnectionsChanged()
            requestBackgroundServiceRestart()
          }
          return result.login ? { ok: true as const, login: result.login } : { ok: true as const }
        }),
      ManosTechConnectionsDisconnect: ({ provider }) =>
        promise(() => {
          const result = disconnectConnection(getStore(), provider)
          notifyConnectionsChanged()
          if (result.envChanged) requestBackgroundServiceRestart()
        }),
      ManosTechConnectionsPermission: ({ provider, permission }) =>
        promise(() => {
          setConnectionPermission(getStore(), provider, permission)
          notifyConnectionsChanged()
        }),
    })
  }),
)

function promise<A>(evaluate: () => A | Promise<A>) {
  return Effect.tryPromise(async () => evaluate()).pipe(Effect.orDie)
}

function notifyConnectionsChanged(): void {
  getMainWindows().forEach((win) => emitIpcEvent(win.webContents, new ManosTechConnectionsChanged({})))
}
