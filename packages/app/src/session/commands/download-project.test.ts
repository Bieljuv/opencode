import { describe, expect, test } from "bun:test"
import { projectDownloadFilename } from "./download-project"

describe("projectDownloadFilename", () => {
  test.each([
    ["/home/usuario/meu-projeto", "meu-projeto.zip"],
    ["C:\\Users\\Gabriel\\Minha Loja", "minha-loja.zip"],
    ["/home/usuario/projeto/", "projeto.zip"],
    ["", "projeto.zip"],
    ["/", "projeto.zip"],
  ])("names %s as %s", (directory, filename) => {
    expect(projectDownloadFilename(directory)).toBe(filename)
  })

  test("shortens long directory names to fit the filename limit", () => {
    expect(projectDownloadFilename(`/home/usuario/${"a".repeat(300)}`)).toBe(`${"a".repeat(250)}.zip`)
  })
})
