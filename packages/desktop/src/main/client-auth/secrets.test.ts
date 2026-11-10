import { describe, expect, test } from "bun:test"
import { decryptSecret, encryptSecret, ENCRYPTED_VALUE_PREFIX, type SecretBackend } from "./secrets"

// Backend falso só para o teste: inverte os bytes. O que está sob teste é
// o envelope (prefixo + base64), o fallback e a leitura de valor legado —
// não a cifra do sistema, que pertence ao Electron.
const fakeBackend: SecretBackend = {
  isEncryptionAvailable: () => true,
  encryptString: (plainText) => Buffer.from(plainText, "utf8").reverse(),
  decryptString: (encrypted) => {
    if (encrypted.length === 0) throw new Error("ciphertext vazio")
    return Buffer.from(encrypted).reverse().toString("utf8")
  },
}

const unavailableBackend: SecretBackend = {
  isEncryptionAvailable: () => false,
  encryptString: () => {
    throw new Error("nunca chamado sem criptografia disponível")
  },
  decryptString: () => {
    throw new Error("nunca chamado sem criptografia disponível")
  },
}

describe("secret codec", () => {
  test.each([["token-falso"], ["chave-falsa"]])(
    "round-trip: criptografa com prefixo e descriptografa de volta (%s)",
    (plainText) => {
      const stored = encryptSecret(plainText, fakeBackend)
      expect(stored.startsWith(ENCRYPTED_VALUE_PREFIX)).toBe(true)
      expect(stored).not.toBe(plainText)
      expect(stored).not.toContain(plainText)
      expect(decryptSecret(stored, fakeBackend)).toBe(plainText)
    },
  )

  test("fallback: sem criptografia disponível, guarda e lê em texto claro como antes", () => {
    expect(encryptSecret("token-falso", undefined)).toBe("token-falso")
    expect(decryptSecret("token-falso", undefined)).toBe("token-falso")
    expect(encryptSecret("token-falso", unavailableBackend)).toBe("token-falso")
    expect(decryptSecret("token-falso", unavailableBackend)).toBe("token-falso")
  })

  test("legado: valor em texto claro sem prefixo continua valendo", () => {
    expect(decryptSecret("token-falso", fakeBackend)).toBe("token-falso")
    expect(decryptSecret("chave-falsa", fakeBackend)).toBe("chave-falsa")
  })

  test("valor criptografado sem backend, ou corrompido, vale como ausente — nunca vaza o ciphertext", () => {
    const stored = encryptSecret("token-falso", fakeBackend)
    expect(decryptSecret(stored, undefined)).toBeUndefined()
    expect(decryptSecret(`${ENCRYPTED_VALUE_PREFIX}!!!`, fakeBackend)).toBeUndefined()
    expect(
      decryptSecret(stored, {
        isEncryptionAvailable: () => true,
        encryptString: (plainText) => Buffer.from(plainText, "utf8"),
        decryptString: () => {
          throw new Error("outro usuário ou máquina")
        },
      }),
    ).toBeUndefined()
  })

  test("string vazia passa vazia, sem prefixo", () => {
    expect(encryptSecret("", fakeBackend)).toBe("")
    expect(decryptSecret("", fakeBackend)).toBe("")
  })
})
