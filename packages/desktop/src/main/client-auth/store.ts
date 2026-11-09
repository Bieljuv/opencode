import { randomUUID } from "node:crypto"
import { Option, Schema } from "effect"
import { getStore } from "../storage/store"
import { MANOSTECH_CLIENT_DEVICE_ID_KEY, MANOSTECH_CLIENT_SESSION_KEY } from "../storage/keys"
import type { SessionData } from "./panel"

/**
 * ManosTech: a sessão do cliente vive no store do processo principal
 * (`opencode.settings`), que só o main lê — o renderer nunca toca no
 * arquivo e nunca vê o token. O token é de 30 dias e revogável no servidor.
 */

const StoredSession = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.NullOr(Schema.String),
  mustChange: Schema.Boolean,
  client: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    email: Schema.String,
    plan: Schema.String,
    ai_mode: Schema.String,
  }),
  trial_ends_at: Schema.NullOr(Schema.String),
})

export type StoredSession = Schema.Schema.Type<typeof StoredSession>

export function saveSession(session: SessionData): void {
  getStore().set(MANOSTECH_CLIENT_SESSION_KEY, {
    token: session.token,
    expires_at: session.expires_at,
    mustChange: session.mustChange,
    client: session.client,
    trial_ends_at: session.trial_ends_at,
  })
}

export function loadSession(): StoredSession | undefined {
  const decoded = Schema.decodeUnknownOption(StoredSession)(getStore().get(MANOSTECH_CLIENT_SESSION_KEY))

  return Option.isSome(decoded) ? decoded.value : undefined
}

export function updateSession(patch: Partial<Pick<StoredSession, "mustChange" | "expires_at" | "trial_ends_at">>): void {
  const current = loadSession()

  if (!current) return

  getStore().set(MANOSTECH_CLIENT_SESSION_KEY, { ...current, ...patch })
}

export function clearSession(): void {
  getStore().delete(MANOSTECH_CLIENT_SESSION_KEY)
}

/** Um id estável por instalação; um login novo no mesmo aparelho vence o anterior. */
export function deviceId(): string {
  const store = getStore()
  const current = store.get(MANOSTECH_CLIENT_DEVICE_ID_KEY)

  if (typeof current === "string" && current.length > 0) return current

  const next = randomUUID()
  store.set(MANOSTECH_CLIENT_DEVICE_ID_KEY, next)

  return next
}
