import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// ManosTech: the ingest secret baked into the main bundle at build time
// (release workflow sets MANOSTECH_INGEST_SECRET). Empty in dev builds,
// so the usage reporter stays silent there.
export const MANOSTECH_INGEST_SECRET = import.meta.env.MANOSTECH_INGEST_SECRET ?? ""

// ManosTech: o Client ID OAuth do Google embutido no build (o workflow de
// release define MANOSTECH_GOOGLE_CLIENT_ID). Ausente até o Client ID
// existir no Google Cloud — sem ele, o botão "Entrar com Google" não
// aparece e o login é só por e-mail e senha.
export const MANOSTECH_GOOGLE_CLIENT_ID =
  import.meta.env.MANOSTECH_GOOGLE_CLIENT_ID === ""
    ? undefined
    : import.meta.env.MANOSTECH_GOOGLE_CLIENT_ID

export const VERSION = app.isPackaged ? app.getVersion() : (process.env.OPENCODE_VERSION ?? app.getVersion())

const appNames: Record<string, string> = {
  dev: "Editor IA ManosTech Dev",
  beta: "Editor IA ManosTech Beta",
  prod: "Editor IA ManosTech",
}

const appIDs: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}

// Local renderer/server mode keeps the dev application identity.
export const APP_NAME = app.isPackaged ? appNames[CHANNEL] : "Editor IA ManosTech Dev"

export const APP_ID = app.isPackaged ? appIDs[CHANNEL] : "ai.opencode.desktop.dev"
