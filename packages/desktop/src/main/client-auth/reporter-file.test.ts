import { describe, expect, test } from "bun:test"
import { parseClientIdentityFile } from "./reporter-file"

// O arquivo de identidade é o acoplamento entre o main e o repórter do
// servidor: o que conta como "inválido" — e portanto merece reescrita no
// getStatus — é o contrato aqui. A leitura e a escrita no caminho do
// Electron não rodam sob `bun test` (electron.app não existe fora do
// app), então o reparo ponta a ponta é provado no app empacotado, não aqui.
describe("parseClientIdentityFile", () => {
  test("accepts a valid identity file, keeping the email as the panel sent it", () => {
    expect(parseClientIdentityFile(JSON.stringify({ client_id: "abc", client_email: "Cliente@Exemplo.com" }))).toEqual({
      id: "abc",
      email: "Cliente@Exemplo.com",
    })
  })

  test("rejects malformed JSON, missing fields, an empty id and a bad email", () => {
    expect(parseClientIdentityFile("not json")).toBeUndefined()
    expect(parseClientIdentityFile(JSON.stringify({ client_id: "abc" }))).toBeUndefined()
    expect(parseClientIdentityFile(JSON.stringify({ client_email: "a@b.com" }))).toBeUndefined()
    expect(parseClientIdentityFile(JSON.stringify({ client_id: "", client_email: "a@b.com" }))).toBeUndefined()
    expect(parseClientIdentityFile(JSON.stringify({ client_id: "abc", client_email: "not-an-email" }))).toBeUndefined()
    expect(parseClientIdentityFile(JSON.stringify({ client_id: 1, client_email: "a@b.com" }))).toBeUndefined()
  })

  test("ignores extra fields", () => {
    expect(
      parseClientIdentityFile(JSON.stringify({ client_id: "abc", client_email: "a@b.com", extra: 1 })),
    ).toEqual({ id: "abc", email: "a@b.com" })
  })
})
