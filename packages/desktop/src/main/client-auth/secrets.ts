import electron from "electron"

/**
 * ManosTech: o token de sessão do painel e a chave API do cliente são
 * segredos — o token vale 30 dias e a chave consome a cota do cliente.
 * Eles vivem no `opencode.settings` criptografados com o `safeStorage` do
 * Electron (DPAPI no Windows, Keychain no macOS, libsecret no Linux), e
 * nunca em texto claro quando a criptografia do sistema está disponível.
 *
 * O valor guardado é `safeStorage:v1:<base64 do ciphertext>`. Sem o
 * prefixo, o valor é legado (texto claro de builds anteriores) e continua
 * valendo: a leitura aceita e a próxima escrita re-criptografa. Sem
 * criptografia disponível (ex.: Linux sem libsecret, ou `bun test`, onde
 * o módulo `electron` não é o runtime do Electron), o valor fica em texto
 * claro como antes — o fallback, não um erro.
 *
 * O `backend` é a dependência de plataforma isolada atrás destas funções:
 * em produção é o `safeStorage` do Electron; nos testes, um backend falso.
 * Nada aqui registra valores — nem em erro.
 */
export const ENCRYPTED_VALUE_PREFIX = "safeStorage:v1:"

export interface SecretBackend {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

function systemBackend(): SecretBackend | undefined {
  const safeStorage = (electron as unknown as { safeStorage?: SecretBackend }).safeStorage

  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function") return undefined

  return safeStorage
}

export function encryptSecret(plainText: string, backend: SecretBackend | undefined = systemBackend()): string {
  if (plainText.length === 0) return plainText
  if (!backend) return plainText

  try {
    if (!backend.isEncryptionAvailable()) return plainText

    return ENCRYPTED_VALUE_PREFIX + Buffer.from(backend.encryptString(plainText)).toString("base64")
  } catch {
    return plainText
  }
}

export function decryptSecret(stored: string, backend: SecretBackend | undefined = systemBackend()): string | undefined {
  if (!stored.startsWith(ENCRYPTED_VALUE_PREFIX)) return stored
  if (!backend) return undefined

  try {
    return backend.decryptString(Buffer.from(stored.slice(ENCRYPTED_VALUE_PREFIX.length), "base64"))
  } catch {
    return undefined
  }
}
