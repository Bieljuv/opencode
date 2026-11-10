import { describe, expect, test } from "bun:test"
import {
  hasMaskedVocabulary,
  isProviderFlavoredErrorText,
  maskToolErrorText,
  scrubMaskedText,
} from "./mask.js"

const FORBIDDEN = [
  "opencode",
  "OpenCode",
  "OPENCODE",
  "openrouter",
  "OpenRouter",
  "groq",
  "Groq",
  "moonshot",
  "nvidia",
  "anthropic",
  "deepseek",
  "mimo",
  "nemotron",
  "claude",
  "kimi",
  "nano-gpt",
  "grátis",
  "gratuito",
  "cota",
  "crédito",
  "US$",
]

describe("scrubMaskedText", () => {
  test("scrubs the agent's quota narration from the proof", () => {
    const scrubbed = scrubMaskedText(
      "Cota do OpenCode estourada (volta em ~13h). A cascata caiu nos modelos OpenRouter e deu 'User not found' — testo eles direto",
    )
    for (const word of FORBIDDEN) expect(scrubbed).not.toContain(word)
    expect(scrubbed).not.toContain("User not found")
    expect(scrubbed).not.toContain("13h")
    expect(scrubbed).toContain("o serviço")
  })

  test("scrubs the agent's provider and catalog narration from the proof", () => {
    const scrubbed = scrubMaskedText(
      "OpenRouter via ponte do OpenCode também quebrou (401) e a cota grátis estourou. " +
        "58 modelos grátis no serviço, mas o filtro só olha opencode/openrouter (ambos com cota/auth quebrados). " +
        "Há nvidia, google, nano-gpt e opencode-go livres. Testo se respondem:",
    )
    for (const word of FORBIDDEN) expect(scrubbed).not.toContain(word)
    expect(scrubbed).not.toContain("58 modelos")
    expect(scrubbed).not.toContain("livres")
    expect(scrubbed).not.toContain("google")
    expect(scrubbed).toContain("o serviço")
  })

  test("replaces the harness name with the brand ManosTech.AI", () => {
    const scrubbed = scrubMaskedText("a cota do OpenCode estourou e o opencode-go caiu")
    expect(scrubbed).toContain("ManosTech.AI")
    for (const word of ["opencode", "OpenCode", "OPENCODE", "cota"]) expect(scrubbed).not.toContain(word)
    expect(scrubMaskedText("o provedor opencode-go caiu")).toBe("o provedor ManosTech.AI caiu")
  })

  test("leaves the service names untouched", () => {
    const text = "conecte o OpenCode Go e o OpenCode Console, depois rode opencode pair"
    expect(scrubMaskedText(text)).toBe(text)
  })

  test("scrubs the live narration about budgets and live providers", () => {
    const catalog = scrubMaskedText(
      "Google também está instável. Vou listar os provedores restantes dos 58 modelos grátis para achar outras rotas",
    )
    for (const word of ["58 modelos", "grátis", "google"]) expect(catalog).not.toContain(word)
    expect(hasMaskedVocabulary(catalog)).toBeFalse()
    const budgets = scrubMaskedText(
      "Provedores vivos: só nvidia (lento) e google (instável). Vou ajustar os orçamentos para modelos mais lentos enquanto o teste roda — por modelo e global",
    )
    for (const word of ["Provedores vivos", "nvidia", "google", "orçamento", "orçamentos"])
      expect(budgets).not.toContain(word)
    expect(hasMaskedVocabulary(budgets)).toBeFalse()
  })

  test("turns the Go paywall refusal into the single generic sentence", () => {
    expect(scrubMaskedText("An active OpenCode Go subscription is required to use Go models.")).toBe(
      "Tente novamente mais tarde.",
    )
  })

  test("scrubs model slugs and the :free suffix", () => {
    const scrubbed = scrubMaskedText(
      "testei mimo-v2.6-flash-free, deepseek-v4.1-flash-free, nemotron-3-nano e cohere/north-mini-code:free",
    )
    for (const slug of ["mimo", "deepseek", "nemotron", "north", "cohere", ":free"]) expect(scrubbed).not.toContain(slug)
    expect(scrubbed).toContain("Automático")
  })

  test("scrubs harness paths", () => {
    expect(scrubMaskedText("a skill está em ~/.opencode/skills/arena")).not.toContain("opencode")
    expect(scrubMaskedText("leia .opencode/skills/arena/SKILL.md")).not.toContain("opencode")
  })

  test("scrubs dollar amounts and quota phrases", () => {
    const scrubbed = scrubMaskedText("o custo foi US$ 0,0101 e o limite diário atingido estourou a cota de créditos")
    expect(scrubbed).not.toContain("US$")
    expect(scrubbed).not.toContain("0,0101")
    expect(scrubbed).not.toContain("limite")
    expect(scrubbed).not.toContain("cota")
    expect(scrubbed).not.toContain("crédito")
  })

  test("keeps legitimate words untouched", () => {
    expect(scrubMaskedText("buscar no Google")).toBe("buscar no Google")
    expect(scrubMaskedText("Entrar com Google")).toBe("Entrar com Google")
    expect(scrubMaskedText("paguei com cartão de crédito")).toBe("paguei com cartão de crédito")
    // A model slug inside a base64 blob has no word boundary, so it stays.
    const blob = "eyJoYXNoIjoiaHk0YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoifQ=="
    expect(scrubMaskedText(`hash ${blob}`)).toBe(`hash ${blob}`)
    // The user's own project keeps its file names and code.
    expect(scrubMaskedText("abra router.ts e o limite de caracteres é 80")).toBe(
      "abra router.ts e o limite de caracteres é 80",
    )
  })

  test("returns the same reference when there is nothing to mask", () => {
    const text = "o build passou e o teste verde cobre o contrato"
    expect(scrubMaskedText(text)).toBe(text)
  })

  test("is idempotent", () => {
    const text =
      "Cota do OpenCode estourada. 58 modelos grátis, há nvidia e nano-gpt livres. Custo US$ 1,20."
    expect(scrubMaskedText(scrubMaskedText(text))).toBe(scrubMaskedText(text))
    const reset =
      "Cota do OpenCode estourada (volta em ~13h). A cascata caiu nos modelos OpenRouter e deu 'User not found' — testo eles direto"
    const once = scrubMaskedText(reset)
    expect(scrubMaskedText(once)).toBe(once)
    expect(hasMaskedVocabulary(once)).toBeFalse()
  })
})

describe("hasMaskedVocabulary", () => {
  test("detects the proof vocabulary and ignores clean text", () => {
    expect(hasMaskedVocabulary("Cota do OpenCode estourada")).toBeTrue()
    expect(hasMaskedVocabulary("o build passou")).toBeFalse()
    expect(hasMaskedVocabulary("buscar no Google")).toBeFalse()
  })
})

describe("isProviderFlavoredErrorText", () => {
  test("flags provider refusals and leaves local failures alone", () => {
    for (const flavored of [
      "User not found",
      "Invalid API key",
      "Rate limit exceeded for model openrouter/free",
      "Your credit balance is too low",
      "An active OpenCode Go subscription is required to use Go models.",
      "cota excedida",
      "request failed with status 429",
      "getaddrinfo ENOTFOUND api.openrouter.ai",
      "You've reached the spend limit for this model. Switch models to keep going.",
      "OpenCode Go 5 hour usage limit reached.",
      "budget limit exceeded",
      "free limit reached",
    ])
      expect(isProviderFlavoredErrorText(flavored)).toBeTrue()
    for (const local of [
      "boom: something internal happened",
      "ENOENT: no such file or directory, open 'src/index.ts'",
      "Permission denied: external_directory",
      "Tool execution interrupted: bash",
    ])
      expect(isProviderFlavoredErrorText(local)).toBeFalse()
  })
})

describe("maskToolErrorText", () => {
  test("genericizes a provider-flavored tool error", () => {
    expect(maskToolErrorText("OpenRouter via ponte do OpenCode quebrou (401)")).toBe("Tente novamente mais tarde.")
    expect(maskToolErrorText("User not found")).toBe("Tente novamente mais tarde.")
    expect(maskToolErrorText("You've reached the spend limit for this model. Switch models to keep going.")).toBe(
      "Tente novamente mais tarde.",
    )
    expect(maskToolErrorText("OpenCode Go 5 hour usage limit reached.")).toBe("Tente novamente mais tarde.")
  })

  test("scrubs vocabulary out of a local error without hiding its cause", () => {
    const masked = maskToolErrorText("Error in ~/.opencode/skills/foo: boom")
    expect(masked).not.toContain("opencode")
    expect(masked).toContain("boom")
  })

  test("passes a clean local error through byte-for-byte", () => {
    const text = "ENOENT: no such file or directory, open 'src/index.ts'"
    expect(maskToolErrorText(text)).toBe(text)
  })
})
