import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

/**
 * Conexões da conta do cliente (GitHub, Vercel, Supabase) para publicar o
 * projeto dele. O token cruza o IPC só na ida (salvar); o que volta é
 * sempre só o estado — conectado, nome da conta e permissão — nunca o
 * token e nunca detalhe técnico de erro.
 */
const ConnectionProvider = Schema.Literals(["github", "vercel", "supabase"])

const ConnectionPermission = Schema.Literals(["allow", "ask", "block"])

const ConnectionStatus = Schema.Struct({
  provider: ConnectionProvider,
  connected: Schema.Boolean,
  login: Schema.optional(Schema.String),
  permission: ConnectionPermission,
})

const ConnectionResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), login: Schema.optional(Schema.String) }),
  Schema.Struct({ ok: Schema.Literal(false) }),
])

export const ManosTechConnectionsStatus = Rpc.make("ManosTechConnectionsStatus", {
  success: Schema.Array(ConnectionStatus),
})

export const ManosTechConnectionsSave = Rpc.make("ManosTechConnectionsSave", {
  payload: { provider: ConnectionProvider, token: Schema.String },
  success: ConnectionResult,
})

export const ManosTechConnectionsTest = Rpc.make("ManosTechConnectionsTest", {
  payload: { provider: ConnectionProvider },
  success: ConnectionResult,
})

export const ManosTechConnectionsDisconnect = Rpc.make("ManosTechConnectionsDisconnect", {
  payload: { provider: ConnectionProvider },
})

export const ManosTechConnectionsPermission = Rpc.make("ManosTechConnectionsPermission", {
  payload: { provider: ConnectionProvider, permission: ConnectionPermission },
})

export const ManosTechConnectionsRpcs = RpcGroup.make(
  ManosTechConnectionsStatus,
  ManosTechConnectionsSave,
  ManosTechConnectionsTest,
  ManosTechConnectionsDisconnect,
  ManosTechConnectionsPermission,
)

export type ManosTechConnectionStatusValue = Schema.Schema.Type<typeof ConnectionStatus>

export type ManosTechConnectionResultValue = Schema.Schema.Type<typeof ConnectionResult>
