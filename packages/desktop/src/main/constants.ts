import { app } from "electron"

type Channel = "local" | "dev" | "beta" | "prod"

const raw = import.meta.env.OPENCODE_CHANNEL

export const CHANNEL: Channel = raw === "local" || raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

// ManosTech: o Client ID OAuth do Google embutido no build (o workflow de
// release define MANOSTECH_GOOGLE_CLIENT_ID). Ausente até o Client ID
// existir no Google Cloud — sem ele, o botão "Entrar com Google" não
// aparece e o login é só por e-mail e senha.
export const MANOSTECH_GOOGLE_CLIENT_ID =
  import.meta.env.MANOSTECH_GOOGLE_CLIENT_ID === ""
    ? undefined
    : import.meta.env.MANOSTECH_GOOGLE_CLIENT_ID

// ManosTech: o segredo do cliente OAuth do Google embutido no build (o
// workflow de release define MANOSTECH_GOOGLE_CLIENT_SECRET). Clientes
// OAuth Desktop são clientes públicos: o Google embute o segredo em apps
// instalados por desenho, e o endpoint de token exige o segredo na troca
// do código — sem ele, o login falha com 400 invalid_request. Ausente
// até o segredo existir no GitHub; sem ele, a troca segue sem segredo,
// como antes.
export const MANOSTECH_GOOGLE_CLIENT_SECRET =
  import.meta.env.MANOSTECH_GOOGLE_CLIENT_SECRET === ""
    ? undefined
    : import.meta.env.MANOSTECH_GOOGLE_CLIENT_SECRET

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
