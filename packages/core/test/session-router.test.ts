import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Model, supportsText } from "@opencode/core/model"
import { decodeSnapshot } from "@opencode/core/models-dev"
import { Provider } from "@opencode/core/provider"
import { Money } from "@opencode/schema/money"
import {
  buildChain,
  classifyComplexity,
  effortFromMetadata,
  effortFromVariant,
  isExhaustionError,
  isFreeModel,
  isHopSignal,
  isRoutable,
  nextHop,
  nextHopFromProvider,
  refKey,
  variantForEffort,
} from "@opencode/core/session/router"

const priced = (input: number, output = 0) => ({
  input: Money.USDPerMillionTokens.make(input),
  output: Money.USDPerMillionTokens.make(output),
  cache: { read: Money.USDPerMillionTokens.zero, write: Money.USDPerMillionTokens.zero },
})

const model = (providerID: string, id: string, overrides: Partial<Model.Info> = {}): Model.Info => ({
  ...Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id)),
  ...overrides,
})

const free = (providerID: string, id: string, overrides: Partial<Model.Info> = {}) =>
  model(providerID, id, overrides)

describe("isFreeModel", () => {
  test("no cost entries is free", () => {
    expect(isFreeModel(free("openrouter", "x-free"))).toBe(true)
  })
  test("zero-priced tiers are free", () => {
    expect(isFreeModel(free("openrouter", "x-free", { cost: [priced(0, 0)] }))).toBe(true)
  })
  test("priced input is paid", () => {
    expect(isFreeModel(free("openrouter", "x", { cost: [priced(1, 0)] }))).toBe(false)
  })
  test("priced output is paid", () => {
    expect(isFreeModel(free("openrouter", "x", { cost: [priced(0, 2)] }))).toBe(false)
  })
})

describe("isRoutable", () => {
  test("a free chat model with tools routes", () => {
    expect(isRoutable(free("openrouter", "x-free"))).toBe(true)
  })
  test("OpenCode Go models never route", () => {
    expect(isRoutable(free("opencode-go", "hy4-preview"))).toBe(false)
  })
  test("deprecated models never route", () => {
    expect(isRoutable(free("openrouter", "x", { status: "deprecated" }))).toBe(false)
  })
  test("models without tools never route", () => {
    expect(
      isRoutable(free("openrouter", "x", { capabilities: { tools: false, input: ["text"], output: ["text"] } })),
    ).toBe(false)
  })
  test("non-chat models never route", () => {
    expect(isRoutable(free("openrouter", "x", { type: "image" }))).toBe(false)
  })
})

describe("classifyComplexity", () => {
  test("a question is simple, even about a change", () => {
    expect(classifyComplexity("Como mudo o botão de lugar?")).toBe("simple")
    expect(classifyComplexity("o que é cache?")).toBe("simple")
    expect(classifyComplexity("qual o melhor jeito de organizar o menu")).toBe("simple")
  })
  test("a small change is simple", () => {
    expect(classifyComplexity("altere o número do whatsapp para (47) 9 9704-9730")).toBe("simple")
    expect(classifyComplexity("troque a cor do botão para azul")).toBe("simple")
  })
  test("a full system is complex", () => {
    expect(classifyComplexity("crie um sistema completo de pedidos com banco de dados e autenticação")).toBe(
      "complex",
    )
  })
  test("two build verbs is complex", () => {
    expect(classifyComplexity("crie a tela de login e corrija o menu")).toBe("complex")
  })
  test("a long request is complex", () => {
    expect(classifyComplexity("refatore o projeto inteiro ".repeat(30))).toBe("complex")
  })
  test("empty is simple", () => {
    expect(classifyComplexity("")).toBe("simple")
  })
})

describe("buildChain", () => {
  const kimi = model("moonshotai", "kimi-k3.1-pro", { cost: [priced(2, 10)] })
  const cheapPaid = model("openrouter", "cheap", { cost: [priced(0.1, 0.4)] })
  const priceyPaid = model("anthropic", "pricey", { cost: [priced(3, 15)] })
  const go = model("opencode-go", "hy4-preview", { cost: [priced(0.8, 2.5)] })
  const pickle = free("opencode", "big-pickle")
  const deepseekFree = free("openrouter", "deepseek-v4.1-flash-free")
  const otherFree = free("openrouter", "other-free")

  test("simple: free first, cheapest paid next, Kimi last, Go never", () => {
    const chain = buildChain([priceyPaid, kimi, otherFree, go, cheapPaid, deepseekFree, pickle], {
      complexity: "simple",
      effort: "automatico",
    })
    expect(chain.map(refKey)).toEqual([
      "opencode/big-pickle",
      "openrouter/deepseek-v4.1-flash-free",
      "openrouter/other-free",
      "openrouter/cheap",
      "anthropic/pricey",
      "moonshotai/kimi-k3.1-pro",
    ])
  })

  test("complex: Kimi first, then cheapest paid, then free", () => {
    const chain = buildChain([otherFree, priceyPaid, kimi, cheapPaid, pickle], {
      complexity: "complex",
      effort: "automatico",
    })
    expect(chain.map(refKey)).toEqual([
      "moonshotai/kimi-k3.1-pro",
      "openrouter/cheap",
      "anthropic/pricey",
      "opencode/big-pickle",
      "openrouter/other-free",
    ])
  })

  test("complex without Moonshot: cheapest paid first, free as fallback", () => {
    const chain = buildChain([priceyPaid, otherFree, cheapPaid], {
      complexity: "complex",
      effort: "automatico",
    })
    expect(chain.map(refKey)).toEqual(["openrouter/cheap", "anthropic/pricey", "openrouter/other-free"])
  })

  test("only free: just the free models, preferred first", () => {
    const chain = buildChain([otherFree, deepseekFree, pickle], {
      complexity: "simple",
      effort: "automatico",
    })
    expect(chain.map(refKey)).toEqual([
      "opencode/big-pickle",
      "openrouter/deepseek-v4.1-flash-free",
      "openrouter/other-free",
    ])
  })

  test("rapido: lightest free first", () => {
    const big = free("openrouter", "big-free", { limit: { context: 200_000, output: 32_000 } })
    const small = free("openrouter", "small-free", { limit: { context: 32_000, output: 8_000 } })
    const mid = free("openrouter", "mid-free", { limit: { context: 128_000, output: 32_000 } })
    const chain = buildChain([big, mid, small], { complexity: "simple", effort: "rapido" })
    expect(chain.map(refKey)).toEqual(["openrouter/small-free", "openrouter/mid-free", "openrouter/big-free"])
  })

  test("effort maps to the variant when the model has one", () => {
    const withVariants = model("moonshotai", "kimi-k3.1-pro", {
      cost: [priced(2, 10)],
      variants: [{ id: Model.VariantID.make("low") }, { id: Model.VariantID.make("high") }],
    })
    const chain = buildChain([withVariants], { complexity: "complex", effort: "aprofundado" })
    expect(chain[0]?.variant).toBe(Model.VariantID.make("high"))
    const fast = buildChain([withVariants], { complexity: "complex", effort: "rapido" })
    expect(fast[0]?.variant).toBe(Model.VariantID.make("low"))
    const auto = buildChain([withVariants], { complexity: "complex", effort: "automatico" })
    expect(auto[0]?.variant).toBeUndefined()
  })

  test("empty pool builds an empty chain", () => {
    expect(buildChain([], { complexity: "simple", effort: "automatico" })).toEqual([])
  })
})

describe("variantForEffort", () => {
  const withVariants = model("moonshotai", "kimi-k3.1-pro", {
    variants: [
      { id: Model.VariantID.make("low") },
      { id: Model.VariantID.make("medium") },
      { id: Model.VariantID.make("high") },
      { id: Model.VariantID.make("max") },
    ],
  })
  test("maps each effort to its variant", () => {
    expect(variantForEffort(withVariants, "rapido")).toBe(Model.VariantID.make("low"))
    expect(variantForEffort(withVariants, "equilibrado")).toBe(Model.VariantID.make("medium"))
    expect(variantForEffort(withVariants, "aprofundado")).toBe(Model.VariantID.make("high"))
    expect(variantForEffort(withVariants, "automatico")).toBeUndefined()
  })
  test("no variants means no variant", () => {
    expect(variantForEffort(free("openrouter", "x-free"), "aprofundado")).toBeUndefined()
  })
})

describe("effortFromMetadata", () => {
  test("passes valid efforts through", () => {
    expect(effortFromMetadata({ manostechEffort: "rapido" })).toBe("rapido")
    expect(effortFromMetadata({ manostechEffort: "aprofundado" })).toBe("aprofundado")
  })
  test("unknown or missing falls back to automatic", () => {
    expect(effortFromMetadata({ manostechEffort: "turbo" })).toBe("automatico")
    expect(effortFromMetadata({})).toBe("automatico")
    expect(effortFromMetadata(undefined)).toBe("automatico")
  })
})

describe("effortFromVariant", () => {
  test("maps reasoning variants to effort", () => {
    expect(effortFromVariant("low")).toBe("rapido")
    expect(effortFromVariant("minimal")).toBe("rapido")
    expect(effortFromVariant("medium")).toBe("equilibrado")
    expect(effortFromVariant("high")).toBe("aprofundado")
    expect(effortFromVariant("max")).toBe("aprofundado")
    expect(effortFromVariant(undefined)).toBe("automatico")
    expect(effortFromVariant("default")).toBe("automatico")
  })
})

describe("nextHop", () => {
  test("skips tried models and ends the chain", () => {
    const chain = buildChain([free("openrouter", "a-free"), free("openrouter", "b-free")], {
      complexity: "simple",
      effort: "automatico",
    })
    expect(nextHop(chain, new Set(["openrouter/a-free"]))?.id).toBe(Model.ID.make("b-free"))
    expect(nextHop(chain, new Set(["openrouter/a-free", "openrouter/b-free"]))).toBeUndefined()
  })
})

describe("isHopSignal", () => {
  test("every limit type and a plain throttle hop; auth, internal, and invalid-request do not", () => {
    for (const type of [
      "provider.exhausted",
      "provider.free-limit",
      "provider.go-limit",
      "provider.budget-limit",
      "provider.model-budget-limit",
      "provider.quota",
      "provider.chatgpt-limit",
      "provider.rate-limit",
    ])
      expect(isHopSignal({ type })).toBe(true)
    for (const type of [
      "provider.auth",
      "provider.internal",
      "provider.invalid-request",
      "provider.content-filter",
    ])
      expect(isHopSignal({ type })).toBe(false)
  })
})

describe("nextHopFromProvider", () => {
  test("prefers another provider, falls back to the same provider when alone", () => {
    const chain = buildChain(
      [free("openrouter", "a-free"), free("nvidia", "b-free"), free("openrouter", "c-free")],
      { complexity: "simple", effort: "automatico" },
    )
    expect(nextHopFromProvider(chain, new Set(["openrouter/a-free"]), "openrouter")?.id).toBe(
      Model.ID.make("b-free"),
    )
    expect(nextHopFromProvider(chain, new Set(["openrouter/a-free", "nvidia/b-free"]), "nvidia")?.id).toBe(
      Model.ID.make("c-free"),
    )
    expect(
      nextHopFromProvider(
        chain,
        new Set(["openrouter/a-free", "nvidia/b-free", "openrouter/c-free"]),
        "openrouter",
      ),
    ).toBeUndefined()
  })
})

describe("chain from the packaged catalog (Gabriel's providers)", () => {
  test("an 'oi' in a new session builds a long multi-provider chain with the gateway before any paid model", async () => {
    // The packaged models.dev snapshot is the catalog the app starts
    // with; the providers are the ones connected on his PC plus the
    // ManosTech gateway. The chain the router builds from it has to be
    // long — a short chain here would mean the catalog itself starves
    // the router, and the hop would have nowhere to go.
    const text = await Bun.file(new URL("../src/models-dev/snapshot.txt", import.meta.url)).text()
    const snapshots = await Effect.runPromise(decodeSnapshot(text))
    const providers = new Set(["opencode", "anthropic", "google", "openrouter", "nvidia", "moonshotai", "nano-gpt"])
    const available = snapshots
      .filter((snapshot) => providers.has(snapshot.info.id))
      .flatMap((snapshot) => snapshot.models)
      .filter((item) => item.status !== "deprecated" && (item.type ?? "chat") === "chat" && supportsText(item))
    // The gateway model, as the ManosTech plugin registers it: free,
    // tools, enabled — in the chain only while its credential is
    // connected. Behind it the panel holds live shared keys for
    // DeepSeek, Moonshot, Nvidia, Groq, and OpenRouter (6 keys).
    const gateway = Model.Info.default(Provider.ID.make("manostech"), Model.ID.make("auto"))
    const pool = [...available, gateway].filter(isRoutable)
    const chain = buildChain([...available, gateway], {
      complexity: classifyComplexity("oi"),
      effort: "automatico",
    })
    expect(chain.length).toBe(pool.length)
    expect(chain.length).toBeGreaterThan(100)
    const freeKeys = new Set(pool.filter(isFreeModel).map(refKey))
    expect(freeKeys.size).toBeGreaterThan(10)
    const gatewayIndex = chain.findIndex((ref) => ref.providerID === "manostech")
    expect(gatewayIndex).toBeGreaterThanOrEqual(0)
    const firstPaidIndex = chain.findIndex((ref) => !freeKeys.has(refKey(ref)))
    expect(gatewayIndex).toBeLessThan(firstPaidIndex)
    expect(chain.some((ref) => ref.providerID === "opencode-go")).toBe(false)
    const last = chain[chain.length - 1]
    expect(last === undefined ? undefined : refKey(last)).toBe("moonshotai/kimi-k3.1-pro")

    // The hop loop the runner runs: every model fails with exhaustion
    // until the gateway, which answers. The gateway is reached before
    // any paid model, so the "oi" never touches a paid personal key.
    const tried = new Set<string>()
    let current = nextHop(chain, tried)
    while (current !== undefined && current.providerID !== "manostech") {
      tried.add(refKey(current))
      current = nextHop(chain, tried)
    }
    expect(current?.providerID).toBe(Provider.ID.make("manostech"))
    expect(tried.size).toBe(gatewayIndex)
    expect(tried.size).toBeLessThan(firstPaidIndex)
  })
})

describe("isExhaustionError", () => {
  test("every limit type hops; a throttle or auth error does not", () => {
    for (const type of [
      "provider.exhausted",
      "provider.free-limit",
      "provider.go-limit",
      "provider.budget-limit",
      "provider.model-budget-limit",
      "provider.quota",
      "provider.chatgpt-limit",
    ])
      expect(isExhaustionError({ type })).toBe(true)
    expect(isExhaustionError({ type: "provider.rate-limit" })).toBe(false)
    expect(isExhaustionError({ type: "provider.auth" })).toBe(false)
    expect(isExhaustionError({ type: "provider.internal" })).toBe(false)
  })
})
