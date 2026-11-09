import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import electron from "electron"

/**
 * ManosTech: o repórter de uso roda no servidor (packages/core) e precisa
 * da identidade do cliente. O main escreve este arquivo a cada login/logout
 * e passa o caminho ao sidecar por variável de ambiente no spawn. Um JSON
 * pequeno é o acoplamento mais simples entre os dois processos — o servidor
 * não lê o banco do desktop e o desktop não reinicia o servidor no login.
 * O arquivo carrega só identidade (nunca o token da sessão).
 */

export function clientFilePath(): string {
  return path.join(electron.app.getPath("userData"), "manostech-client.json")
}

export function writeClientIdentity(client: { id: string; email: string }): void {
  writeFileSync(
    clientFilePath(),
    JSON.stringify({ client_id: client.id, client_email: client.email }),
    { mode: 0o600 },
  )
}

export function clearClientIdentity(): void {
  rmSync(clientFilePath(), { force: true })
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Valida o conteúdo do arquivo de identidade — as mesmas regras que o
 * repórter usa para ler (o repórter vive no servidor e não pode importar
 * daqui). Inválido = undefined: JSON quebrado, campo faltando, id vazio
 * ou e-mail fora do formato. O e-mail é guardado como veio do painel,
 * sem normalizar, para o reparo não reescrever um arquivo certo.
 */
export function parseClientIdentityFile(text: string): { id: string; email: string } | undefined {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text)
    } catch {
      return undefined
    }
  })()

  if (typeof parsed !== "object" || parsed === null) return undefined

  const id = (parsed as Record<string, unknown>).client_id
  const email = (parsed as Record<string, unknown>).client_email

  if (typeof id !== "string" || id.length === 0) return undefined
  if (typeof email !== "string" || !EMAIL_PATTERN.test(email)) return undefined

  return { id, email }
}

/** A identidade guardada, quando o arquivo existe e é válido. */
export function readClientIdentity(): { id: string; email: string } | undefined {
  const file = clientFilePath()

  if (!existsSync(file)) return undefined

  try {
    return parseClientIdentityFile(readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * Reescreve o arquivo de identidade com a sessão guardada quando ele
 * falta, está inválido ou descreve outro cliente; com a identidade
 * certa já guardada, não toca no arquivo. O arquivo só era escrito no
 * login — sem o reparo, um arquivo sumido ou corrompido deixava o
 * repórter mudo até o próximo login.
 */
export function repairClientIdentity(client: { id: string; email: string }): void {
  const current = readClientIdentity()

  if (current?.id === client.id && current?.email === client.email) return

  writeClientIdentity(client)
}
