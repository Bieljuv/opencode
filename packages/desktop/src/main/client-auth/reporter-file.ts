import { rmSync, writeFileSync } from "node:fs"
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
