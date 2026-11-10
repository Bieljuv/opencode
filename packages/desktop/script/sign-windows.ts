import { spawnSync } from "node:child_process"
import type { CustomWindowsSign } from "electron-builder"

// Optional Windows code signing for the Editor IA ManosTech installer
// (audit item I13). The hook is fail-open: without a signing command
// configured, the build ships unsigned exactly as today. With one,
// electron-builder runs it once per file (app executable, NSIS installer,
// uninstaller) with the file path as the last argument, and a failed
// signing fails the build on purpose — a release that was meant to be
// signed must never ship unsigned by mistake.
//
// Configure it with the full signing command, e.g. Certum SimplySign
// (see the Forge signing guide, GUIA-ASSINATURA.md):
//   MANOSTECH_SIGN_CMD=signtool sign /a /n "Manos Tech" /tr http://time.certum.pl /td sha256 /fd sha256
// or SSL.com eSigner CodeSignTool:
//   MANOSTECH_SIGN_CMD=CodeSignTool sign -username=USUARIO -password=SENHA -credential_id=ID
//
// No certificate is bought or configured here — buying one is a separate
// decision (the guide recommends Certum Standard OV, ~US$ 99/year).
// Since mid-2023 the key lives in a cloud HSM or USB token, so there is no
// .pfx file to commit; the command above is the only thing the build needs.

export const WINDOWS_SIGN_COMMAND_ENV = "MANOSTECH_SIGN_CMD"

export function isWindowsSigningConfigured(): boolean {
  return (process.env[WINDOWS_SIGN_COMMAND_ENV] ?? "").trim() !== ""
}

// The hook captures the command when the config loads, so what it signs
// with can never drift from what verifyUpdateCodeSignature was decided
// from: if the command were read again at signing time and the variable
// had been unset in between, the file would silently ship unsigned while
// the updater demands a signature.
export function createWindowsSignHook(
  command: string | undefined = process.env[WINDOWS_SIGN_COMMAND_ENV],
): CustomWindowsSign {
  return async (configuration) => {
    if (!command?.trim()) return
    const parts = splitCommand(command)
    const executable = parts.shift()
    if (!executable) throw new Error(`${WINDOWS_SIGN_COMMAND_ENV} is set but empty or invalid.`)
    const result = spawnSync(executable, [...parts, configuration.path], { stdio: "inherit", shell: false })
    if (result.error) throw new Error(`Failed to run the Windows signer: ${result.error.message}`)
    if (result.status !== 0)
      throw new Error(`Failed to sign ${configuration.path} (exit code ${result.status}).`)
  }
}

function splitCommand(command: string): Array<string> {
  return (command.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []).map((part) => part.replace(/^"|"$/g, ""))
}
