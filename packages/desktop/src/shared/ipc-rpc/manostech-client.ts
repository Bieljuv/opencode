import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"

const ClientProfile = Schema.Struct({
  name: Schema.String,
  email: Schema.String,
})

const ClientStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("logged-out") }),
  Schema.Struct({
    state: Schema.Literal("ready"),
    client: ClientProfile,
    trialEndsAt: Schema.NullOr(Schema.String),
    gatewayActive: Schema.Boolean,
  }),
  Schema.Struct({ state: Schema.Literal("must-change"), client: ClientProfile }),
  Schema.Struct({ state: Schema.Literal("trial-expired"), trialEndsAt: Schema.NullOr(Schema.String) }),
])

/** Uso diário do plano, já agregado: só percentual e hora do reset. */
const ClientUsage = Schema.Struct({
  percent: Schema.Number,
  resetsAt: Schema.String,
  warnedToday: Schema.Boolean,
})

const ClientError = Schema.Struct({
  tag: Schema.Union([
    Schema.Literal("invalid-credentials"),
    Schema.Literal("account-inactive"),
    Schema.Literal("trial-expired"),
    Schema.Literal("password-too-short"),
    Schema.Literal("email-in-use"),
    Schema.Literal("google-unavailable"),
    Schema.Literal("network"),
    Schema.Literal("unknown"),
  ]),
  trial_ends_at: Schema.optional(Schema.String),
})

export const ManosTechClientStatus = Rpc.make("ManosTechClientStatus", { success: ClientStatus })

export const ManosTechClientLogin = Rpc.make("ManosTechClientLogin", {
  payload: { email: Schema.String, password: Schema.String },
  success: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), status: ClientStatus }),
    Schema.Struct({ ok: Schema.Literal(false), error: ClientError }),
  ]),
})

export const ManosTechClientChangePassword = Rpc.make("ManosTechClientChangePassword", {
  payload: { current: Schema.String, next: Schema.String },
  success: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true) }),
    Schema.Struct({ ok: Schema.Literal(false), error: ClientError }),
  ]),
})

export const ManosTechClientLogout = Rpc.make("ManosTechClientLogout")

export const ManosTechClientGoogleAvailable = Rpc.make("ManosTechClientGoogleAvailable", {
  success: Schema.Boolean,
})

export const ManosTechClientGoogleStart = Rpc.make("ManosTechClientGoogleStart", {
  success: Schema.Struct({ available: Schema.Boolean }),
})

export const ManosTechClientUsage = Rpc.make("ManosTechClientUsage", {
  success: Schema.NullOr(ClientUsage),
})

export const ManosTechClientUsageWarned = Rpc.make("ManosTechClientUsageWarned")

export const ManosTechClientTranscribe = Rpc.make("ManosTechClientTranscribe", {
  payload: { audio: Schema.String },
  success: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), text: Schema.String }),
    Schema.Struct({
      ok: Schema.Literal(false),
      error: Schema.Union([Schema.Literal("unavailable"), Schema.Literal("failed")]),
    }),
  ]),
})

export const ManosTechClientRpcs = RpcGroup.make(
  ManosTechClientStatus,
  ManosTechClientLogin,
  ManosTechClientChangePassword,
  ManosTechClientLogout,
  ManosTechClientGoogleAvailable,
  ManosTechClientGoogleStart,
  ManosTechClientUsage,
  ManosTechClientUsageWarned,
  ManosTechClientTranscribe,
)

export type ManosTechClientStatusValue = Schema.Schema.Type<typeof ClientStatus>

export type ManosTechClientUsageValue = Schema.Schema.Type<typeof ClientUsage>

export type ManosTechClientErrorValue = Schema.Schema.Type<typeof ClientError>

export type ManosTechClientLoginValue =
  | { readonly ok: true; readonly status: ManosTechClientStatusValue }
  | { readonly ok: false; readonly error: ManosTechClientErrorValue }

export type ManosTechClientChangePasswordValue =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: ManosTechClientErrorValue }

export type ManosTechClientTranscribeValue =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: "unavailable" | "failed" }
