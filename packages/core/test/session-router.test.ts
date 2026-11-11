import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AIError, classifyProviderFailure } from "@opencode/ai/effect"
import { Model, supportsText } from "@opencode/core/model"
import { decodeSnapshot } from "@opencode/core/models-dev"
import { Provider } from "@opencode/core/provider"
import { toSessionError } from "@opencode/core/session/to-session-error"
import { Token } from "@opencode/core/util/token"
import { Money } from "@opencode/schema/money"
import {
  CASCADE_BUDGET_MS,
  CASCADE_EXHAUSTED,
  FIRST_OUTPUT_TIMEOUT_MS,
  buildChain,
  cascadeBudgetSpent,
  classifyComplexity,
  complexityForGateway,
  effortFromMetadata,
  effortFromVariant,
  fitsPrompt,
  gatewayComplexityBody,
  isExhaustionError,
  isFreeModel,
  isGatewayModel,
  isHopSignal,
  isRoutable,
  multiAgentFromMetadata,
  nextHop,
  nextHopFor,
  nextHopFromProvider,
  nextHopWithLargerWindow,
  refKey,
  requestCeiling,
  sessionFallback,
  stepHead,
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

describe("isGatewayModel", () => {
  test("the gateway's single route is the gateway model", () => {
    expect(isGatewayModel({ providerID: Provider.ID.make("manostech"), id: Model.ID.make("auto") })).toBe(true)
  })
  test("a direct free model is not the gateway model", () => {
    expect(isGatewayModel({ providerID: Provider.ID.make("opencode"), id: Model.ID.make("mimo-v2.6-flash-free") })).toBe(
      false,
    )
  })
  test("no session model is not the gateway model", () => {
    expect(isGatewayModel(undefined)).toBe(false)
  })
})

describe("complexityForGateway", () => {
  test("a complex turn is complexa for the gateway", () => {
    expect(complexityForGateway("complex")).toBe("complexa")
  })
  test("a simple turn is simples for the gateway", () => {
    expect(complexityForGateway("simple")).toBe("simples")
  })
})

describe("gatewayComplexityBody", () => {
  const gateway = { providerID: Provider.ID.make("manostech"), id: Model.ID.make("auto") }
  const direct = { providerID: Provider.ID.make("opencode"), id: Model.ID.make("mimo-v2.6-flash-free") }
  test("a complex gateway turn carries complexa", () => {
    expect(gatewayComplexityBody(gateway, "complex")).toEqual({ manostech_complexidade: "complexa" })
  })
  test("a simple gateway turn carries simples", () => {
    expect(gatewayComplexityBody(gateway, "simple")).toEqual({ manostech_complexidade: "simples" })
  })
  test("a direct model never carries the field", () => {
    expect(gatewayComplexityBody(direct, "complex")).toBeUndefined()
  })
  test("no classified complexity carries nothing", () => {
    expect(gatewayComplexityBody(gateway, undefined)).toBeUndefined()
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

  test("rotation: consecutive turns start on different free models", () => {
    const pool = [priceyPaid, kimi, otherFree, cheapPaid, deepseekFree, pickle]
    const input = { complexity: "simple" as const, effort: "automatico" as const }
    const first = buildChain(pool, input)
    const second = buildChain(pool, { ...input, rotateAfter: first[0] })
    const third = buildChain(pool, { ...input, rotateAfter: second[0] })
    expect(first.map(refKey)[0]).toBe("opencode/big-pickle")
    expect(second.map(refKey)[0]).toBe("openrouter/deepseek-v4.1-flash-free")
    expect(third.map(refKey)[0]).toBe("openrouter/other-free")
    // The whole chain is still there, just rotated: the fallback follows the new head.
    expect(second.map(refKey)).toEqual([
      "openrouter/deepseek-v4.1-flash-free",
      "openrouter/other-free",
      "opencode/big-pickle",
      "openrouter/cheap",
      "anthropic/pricey",
      "moonshotai/kimi-k3.1-pro",
    ])
  })

  test("rotation: after the last free model it wraps to the first", () => {
    const pool = [otherFree, deepseekFree, pickle]
    const chain = buildChain(pool, {
      complexity: "simple",
      effort: "automatico",
      rotateAfter: Model.Ref.make({
        providerID: Provider.ID.make("openrouter"),
        id: Model.ID.make("other-free"),
      }),
    })
    expect(chain.map(refKey)).toEqual([
      "opencode/big-pickle",
      "openrouter/deepseek-v4.1-flash-free",
      "openrouter/other-free",
    ])
  })

  test("rotation: a model outside the free run leaves the order untouched", () => {
    const pool = [priceyPaid, kimi, otherFree, cheapPaid, deepseekFree, pickle]
    const afterPaid = buildChain(pool, {
      complexity: "simple",
      effort: "automatico",
      rotateAfter: Model.Ref.make({
        providerID: Provider.ID.make("moonshotai"),
        id: Model.ID.make("kimi-k3.1-pro"),
      }),
    })
    expect(afterPaid.map(refKey)[0]).toBe("opencode/big-pickle")
    const afterUnknown = buildChain(pool, {
      complexity: "simple",
      effort: "automatico",
      rotateAfter: Model.Ref.make({ providerID: Provider.ID.make("nope"), id: Model.ID.make("nope") }),
    })
    expect(afterUnknown.map(refKey)).toEqual(
      buildChain(pool, { complexity: "simple", effort: "automatico" }).map(refKey),
    )
  })

  test("rotation: a single free model never changes", () => {
    const chain = buildChain([otherFree, cheapPaid], {
      complexity: "simple",
      effort: "automatico",
      rotateAfter: Model.Ref.make({
        providerID: Provider.ID.make("openrouter"),
        id: Model.ID.make("other-free"),
      }),
    })
    expect(chain.map(refKey)[0]).toBe("openrouter/other-free")
  })

  test("rotation: a complex turn never rotates down to a free model", () => {
    const pool = [otherFree, priceyPaid, kimi, cheapPaid, pickle]
    const chain = buildChain(pool, {
      complexity: "complex",
      effort: "automatico",
      rotateAfter: Model.Ref.make({ providerID: Provider.ID.make("opencode"), id: Model.ID.make("big-pickle") }),
    })
    expect(chain.map(refKey)).toEqual([
      "moonshotai/kimi-k3.1-pro",
      "openrouter/cheap",
      "anthropic/pricey",
      "openrouter/other-free",
      "opencode/big-pickle",
    ])
  })

  test("rotation: only models that fit the prompt can lead", () => {
    const small = free("opencode", "big-pickle", { limit: { context: 32_000, output: 8_000 } })
    const big = free("openrouter", "deepseek-v4.1-flash-free", { limit: { context: 200_000, output: 32_000 } })
    const mid = free("openrouter", "other-free", { limit: { context: 200_000, output: 32_000 } })
    const input = { complexity: "simple" as const, effort: "automatico" as const, promptTokens: 40_000 }
    const chain = buildChain([small, big, mid], input)
    expect(chain.map(refKey)).toEqual(["openrouter/deepseek-v4.1-flash-free", "openrouter/other-free"])
    const rotated = buildChain([small, big, mid], {
      ...input,
      rotateAfter: Model.Ref.make({
        providerID: Provider.ID.make("openrouter"),
        id: Model.ID.make("deepseek-v4.1-flash-free"),
      }),
    })
    expect(rotated.map(refKey)[0]).toBe("openrouter/other-free")
    // The too-small model is out of the chain, so rotating after it changes nothing.
    const afterSmall = buildChain([small, big, mid], {
      ...input,
      rotateAfter: Model.Ref.make({ providerID: Provider.ID.make("opencode"), id: Model.ID.make("big-pickle") }),
    })
    expect(afterSmall.map(refKey)).toEqual(chain.map(refKey))
  })
})

describe("stepHead", () => {
  const ref = (providerID: string, id: string) =>
    Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })
  const chain = buildChain(
    [
      model("anthropic", "pricey", { cost: [priced(3, 15)] }),
      free("openrouter", "other-free"),
      free("opencode", "big-pickle"),
    ],
    { complexity: "simple", effort: "automatico" },
  )

  test("a new turn takes the chain head", () => {
    expect(stepHead(chain, new Set(), undefined, true, false)).toEqual(ref("opencode", "big-pickle"))
    expect(stepHead(chain, new Set(), ref("openrouter", "other-free"), true, true)).toEqual(
      ref("opencode", "big-pickle"),
    )
  })

  test("a continuation step on a free model rotates to the next free model", () => {
    const pool = [
      model("anthropic", "pricey", { cost: [priced(3, 15)] }),
      free("openrouter", "other-free"),
      free("opencode", "big-pickle"),
    ]
    const input = { complexity: "simple" as const, effort: "automatico" as const }
    const afterPickle = buildChain(pool, {
      ...input,
      rotateAfter: ref("opencode", "big-pickle"),
    })
    expect(stepHead(afterPickle, new Set(), ref("opencode", "big-pickle"), false, true)).toEqual(
      ref("openrouter", "other-free"),
    )
    // After the last free model it wraps to the first.
    const afterOther = buildChain(pool, {
      ...input,
      rotateAfter: ref("openrouter", "other-free"),
    })
    expect(stepHead(afterOther, new Set(), ref("openrouter", "other-free"), false, true)).toEqual(
      ref("opencode", "big-pickle"),
    )
  })

  test("consecutive steps in one turn alternate free models", () => {
    const pool = [
      model("anthropic", "pricey", { cost: [priced(3, 15)] }),
      free("openrouter", "other-free"),
      free("opencode", "big-pickle"),
    ]
    const input = { complexity: "simple" as const, effort: "automatico" as const }
    // Step 1, new turn: starts on the preferred free model.
    const first = buildChain(pool, input)
    expect(stepHead(first, new Set(), undefined, true, false)).toEqual(ref("opencode", "big-pickle"))
    // Step 2, continuation: rotates to the next free model.
    const second = buildChain(pool, { ...input, rotateAfter: ref("opencode", "big-pickle") })
    expect(stepHead(second, new Set(), ref("opencode", "big-pickle"), false, true)).toEqual(
      ref("openrouter", "other-free"),
    )
    // Step 3, continuation: wraps back to the first free model.
    const third = buildChain(pool, { ...input, rotateAfter: ref("openrouter", "other-free") })
    expect(stepHead(third, new Set(), ref("openrouter", "other-free"), false, true)).toEqual(
      ref("opencode", "big-pickle"),
    )
  })

  test("a continuation step keeps a paid session model", () => {
    expect(stepHead(chain, new Set(), ref("anthropic", "pricey"), false, false)).toEqual(
      ref("anthropic", "pricey"),
    )
  })

  test("a continuation step on a complex turn keeps the paid head", () => {
    const complexChain = buildChain(
      [
        model("moonshotai", "kimi-k3.1-pro", { cost: [priced(2, 10)] }),
        model("openrouter", "cheap", { cost: [priced(0.1, 0.4)] }),
        model("anthropic", "pricey", { cost: [priced(3, 15)] }),
        free("openrouter", "other-free"),
        free("opencode", "big-pickle"),
      ],
      { complexity: "complex", effort: "automatico" },
    )
    expect(stepHead(complexChain, new Set(), ref("moonshotai", "kimi-k3.1-pro"), false, false)).toEqual(
      ref("moonshotai", "kimi-k3.1-pro"),
    )
  })

  test("a continuation step on a complex turn that fell back to free retries the paid head", () => {
    const complexChain = buildChain(
      [
        model("moonshotai", "kimi-k3.1-pro", { cost: [priced(2, 10)] }),
        model("openrouter", "cheap", { cost: [priced(0.1, 0.4)] }),
        model("anthropic", "pricey", { cost: [priced(3, 15)] }),
        free("openrouter", "other-free"),
        free("opencode", "big-pickle"),
      ],
      { complexity: "complex", effort: "automatico" },
    )
    expect(stepHead(complexChain, new Set(), ref("openrouter", "other-free"), false, true)).toEqual(
      ref("moonshotai", "kimi-k3.1-pro"),
    )
  })

  test("a continuation step falls back to the head when the session model left the chain", () => {
    expect(stepHead(chain, new Set(), ref("moonshotai", "kimi-k3.1-pro"), false, false)).toEqual(
      ref("opencode", "big-pickle"),
    )
    expect(stepHead(chain, new Set(), undefined, false, false)).toEqual(ref("opencode", "big-pickle"))
  })

  test("a continuation step skips a session model already tried", () => {
    expect(
      stepHead(chain, new Set(["openrouter/other-free"]), ref("openrouter", "other-free"), false, true),
    ).toEqual(ref("opencode", "big-pickle"))
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

describe("multiAgentFromMetadata", () => {
  test("multi-agent is on unless explicitly turned off", () => {
    expect(multiAgentFromMetadata({ manostechMultiAgent: true })).toBe(true)
    expect(multiAgentFromMetadata({ manostechMultiAgent: false })).toBe(false)
    // A prompt with no toggle — CLI, ACP, schedules, child sessions — runs
    // multi-agent, exactly like a composer prompt with the toggle on.
    expect(multiAgentFromMetadata({ manostechMultiAgent: "true" })).toBe(true)
    expect(multiAgentFromMetadata({})).toBe(true)
    expect(multiAgentFromMetadata(undefined)).toBe(true)
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

describe("requestCeiling", () => {
  test("a window keeps 15% or 16k tokens for the reply, whichever is more", () => {
    expect(requestCeiling({ context: 200_000, output: 32_000 })).toBe(170_000)
    expect(requestCeiling({ context: 128_000, output: 32_000 })).toBe(108_800)
    expect(requestCeiling({ context: 32_000, output: 8_000 })).toBe(16_000)
    expect(requestCeiling({ context: 8_000, output: 2_000 })).toBe(6_800)
  })
  test("an unknown window never excludes", () => {
    expect(requestCeiling({ context: 0, output: 32_000 })).toBe(Number.POSITIVE_INFINITY)
  })
  test("an input limit below the window caps the ceiling", () => {
    expect(requestCeiling({ context: 200_000, input: 32_000, output: 32_000 })).toBe(16_000)
  })
})

describe("fitsPrompt", () => {
  test("a prompt at the ceiling fits, one token over does not", () => {
    const model = free("openrouter", "x-free", { limit: { context: 32_000, output: 8_000 } })
    expect(fitsPrompt(model, 16_000)).toBe(true)
    expect(fitsPrompt(model, 16_001)).toBe(false)
  })
  test("an unknown window always fits", () => {
    const model = free("openrouter", "x-free", { limit: { context: 0, output: 32_000 } })
    expect(fitsPrompt(model, 1_000_000)).toBe(true)
  })
})

describe("buildChain with promptTokens", () => {
  const smallFree = free("openrouter", "small-free", { limit: { context: 32_000, output: 8_000 } })
  const bigFree = free("openrouter", "big-free", { limit: { context: 200_000, output: 32_000 } })
  const bigPaid = model("anthropic", "big-paid", {
    cost: [priced(3, 15)],
    limit: { context: 200_000, output: 32_000 },
  })

  test("a big prompt drops small-window free models", () => {
    const chain = buildChain([smallFree, bigFree, bigPaid], {
      complexity: "simple",
      effort: "automatico",
      promptTokens: 100_000,
    })
    expect(chain.map(refKey)).toEqual(["openrouter/big-free", "anthropic/big-paid"])
  })

  test("when no free model fits, the chain starts at the paid models that do", () => {
    const chain = buildChain([smallFree, bigPaid], {
      complexity: "simple",
      effort: "automatico",
      promptTokens: 100_000,
    })
    expect(chain.map(refKey)).toEqual(["anthropic/big-paid"])
  })

  test("a prompt bigger than every window keeps the unfiltered chain", () => {
    const chain = buildChain([smallFree, bigFree], {
      complexity: "simple",
      effort: "automatico",
      promptTokens: 1_000_000,
    })
    expect(chain.map(refKey)).toEqual(["openrouter/small-free", "openrouter/big-free"])
  })

  test("a small prompt keeps the usual order", () => {
    const pool = [smallFree, bigFree, bigPaid]
    const input = { complexity: "simple" as const, effort: "automatico" as const }
    expect(buildChain(pool, { ...input, promptTokens: 1_000 }).map(refKey)).toEqual(
      buildChain(pool, input).map(refKey),
    )
  })

  test("the real 6,392-character prompt fits every model, so the filter changes nothing", () => {
    // A real session prompt of 6,392 characters: three models answered a
    // small probe in seconds and then froze on it. The window filter
    // cannot explain that freeze — 1,598 tokens fits any window — so the
    // chain must be identical with and without the filter, and the rescue
    // for that case is the hop on the mid-task failure, not the filter.
    const promptTokens = Token.estimate("x".repeat(6_392))
    expect(promptTokens).toBe(1_598)
    const pool = [smallFree, bigFree, bigPaid]
    const input = { complexity: "simple" as const, effort: "automatico" as const }
    expect(buildChain(pool, { ...input, promptTokens }).map(refKey)).toEqual(
      buildChain(pool, input).map(refKey),
    )
  })
})

describe("nextHopWithLargerWindow", () => {
  const small = free("openrouter", "small-free", { limit: { context: 32_000, output: 8_000 } })
  const mid = free("openrouter", "mid-free", { limit: { context: 128_000, output: 32_000 } })
  const big = free("nvidia", "big-free", { limit: { context: 200_000, output: 32_000 } })
  const pool = [small, mid, big]

  test("picks the next untried model with a strictly larger window", () => {
    const chain = buildChain(pool, { complexity: "simple", effort: "automatico" })
    expect(nextHopWithLargerWindow(pool, chain, new Set(["openrouter/small-free"]), small)?.id).toBe(
      Model.ID.make("mid-free"),
    )
    expect(
      nextHopWithLargerWindow(
        pool,
        chain,
        new Set(["openrouter/small-free", "openrouter/mid-free"]),
        small,
      )?.id,
    ).toBe(Model.ID.make("big-free"))
  })

  test("returns undefined when no untried model has a larger window", () => {
    const chain = buildChain(pool, { complexity: "simple", effort: "automatico" })
    expect(nextHopWithLargerWindow(pool, chain, new Set(), big)).toBeUndefined()
    expect(
      nextHopWithLargerWindow(
        pool,
        chain,
        new Set(["openrouter/mid-free", "nvidia/big-free"]),
        small,
      ),
    ).toBeUndefined()
  })

  test("a model with an unknown window never counts as larger", () => {
    const unknown = free("openrouter", "unknown-free", { limit: { context: 0, output: 32_000 } })
    const chain = buildChain([small, unknown], { complexity: "simple", effort: "automatico" })
    expect(nextHopWithLargerWindow([small, unknown], chain, new Set(), small)).toBeUndefined()
  })
})

describe("isHopSignal", () => {
  test("every limit type, a plain throttle, auth, and mid-task failures hop; content-filter and invalid-request do not", () => {
    for (const type of [
      "provider.exhausted",
      "provider.free-limit",
      "provider.go-limit",
      "provider.budget-limit",
      "provider.model-budget-limit",
      "provider.quota",
      "provider.chatgpt-limit",
      "provider.rate-limit",
      // A dead key is per provider: the next provider answers instead of the turn dying on it.
      "provider.auth",
      // A model that freezes or fails mid-task is skipped, not retried until the turn dies.
      "provider.timeout",
      "provider.internal",
      "provider.invalid-output",
      "provider.context-too-long",
    ])
      expect(isHopSignal({ type })).toBe(true)
    for (const type of ["provider.content-filter", "provider.invalid-request"])
      expect(isHopSignal({ type })).toBe(false)
  })

  test("an expired ManosTech client key never hops and is never exhaustion", () => {
    // Every gateway model shares the same client key: hopping would fail
    // the same way on each model, and the key never heals with backoff —
    // so the runner ends the turn with the error itself instead.
    expect(isHopSignal({ type: "provider.key-expired" })).toBe(false)
    expect(isExhaustionError({ type: "provider.key-expired" })).toBe(false)
  })

  test("an auth failure hops to another provider instead of killing the turn (log 2026-11-10)", () => {
    // Gabriel's "oi" (2026-11-10 16:01:15Z): the first model failed with
    // quota and the router hopped, but the second failed with auth and
    // the turn died there with 841 models untried. The hop decisions the
    // runner makes, in order: exhaustion hops to the next model, auth
    // hops to a model of another provider, and the third model answers.
    const chain = buildChain(
      [free("openrouter", "a-free"), free("nvidia", "b-free"), free("google", "c-free")],
      { complexity: "simple", effort: "automatico" },
    )
    expect(chain.length).toBe(3)
    const tried = new Set<string>()
    // First model: quota exhausted — hop to the next model in the chain.
    const first = nextHop(chain, tried)
    expect(first).toBeDefined()
    expect(isHopSignal({ type: "provider.exhausted" })).toBe(true)
    if (first === undefined) return
    tried.add(refKey(first))
    const second = nextHop(chain, tried)
    expect(second).toBeDefined()
    if (second === undefined) return
    expect(second.providerID).not.toBe(first.providerID)
    // Second model: dead key — hop again, to another provider, not death.
    expect(isHopSignal({ type: "provider.auth" })).toBe(true)
    expect(isExhaustionError({ type: "provider.auth" })).toBe(false)
    tried.add(refKey(second))
    const third = nextHopFromProvider(chain, tried, second.providerID)
    expect(third).toBeDefined()
    if (third === undefined) return
    expect(third.providerID).not.toBe(second.providerID)
    // Third model answers; the turn never sees either failure.
    tried.add(refKey(third))
    expect(nextHop(chain, tried)).toBeUndefined()
    expect(nextHopFromProvider(chain, tried, third.providerID)).toBeUndefined()
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

describe("cascade speed limits", () => {
  test("a 30s first-output deadline and a 90s cascade budget, both below Gabriel's 142.8s gate", () => {
    // One model held the user 142.8s in Gabriel's gate test (2026-11-10
    // 08:50, "lento demais"). The whole cascade — several frozen models —
    // must resolve before that: three attempts at the 30s deadline is
    // 90s, still 52.8s below the ceiling a single model took. The failure
    // is the generic message, never a detail about the models tried.
    expect(FIRST_OUTPUT_TIMEOUT_MS).toBe(30_000)
    expect(CASCADE_BUDGET_MS).toBe(90_000)
    expect(CASCADE_BUDGET_MS).toBeLessThan(142_800)
    expect(CASCADE_EXHAUSTED).toEqual({ type: "provider.exhausted", message: "Tente novamente mais tarde." })
  })

  test("the budget only bounds total silence: output started, or time left, means not spent", () => {
    expect(cascadeBudgetSpent(1_000, 1_000 + CASCADE_BUDGET_MS - 1, false)).toBe(false)
    expect(cascadeBudgetSpent(1_000, 1_000 + CASCADE_BUDGET_MS, false)).toBe(true)
    expect(cascadeBudgetSpent(1_000, 1_000 + CASCADE_BUDGET_MS + 60_000, false)).toBe(true)
    expect(cascadeBudgetSpent(1_000, 1_000 + CASCADE_BUDGET_MS + 60_000, true)).toBe(false)
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

describe("nextHopFor", () => {
  const ref = (providerID: string, id: string) =>
    Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })
  // The shape the runner hands over: a catalog model plus its resolved ref.
  const resolved = (info: Model.Info) => ({
    ...info,
    ref: Model.Ref.make({ providerID: info.providerID, id: info.id }),
  })
  const gateway = resolved(free("manostech", "auto"))
  const chain = [
    ref("manostech", "auto"),
    ref("openrouter", "a-free"),
    ref("nvidia", "b-free"),
    ref("anthropic", "pricey"),
  ]
  const pool = [
    free("manostech", "auto"),
    free("openrouter", "a-free"),
    free("nvidia", "b-free"),
    model("anthropic", "pricey", { cost: [priced(3, 15)] }),
  ]

  test("an auth failure on the gateway hops to the next model on another provider", () => {
    // Gabriel's log (2026-11-11 13:29:21Z): a model failed with a dead
    // key and the step died instead of trying the next model in the
    // chain. Auth is a hop signal — the credential is per provider, so
    // a dead key on one provider must not condemn the others, and the
    // hop prefers a different provider.
    expect(nextHopFor(chain, new Set(["manostech/auto"]), pool, { type: "provider.auth" }, gateway)).toEqual(
      ref("openrouter", "a-free"),
    )
  })

  test("an auth failure with the whole chain tried returns undefined", () => {
    expect(
      nextHopFor(
        chain,
        new Set(["manostech/auto", "openrouter/a-free", "nvidia/b-free", "anthropic/pricey"]),
        pool,
        { type: "provider.auth" },
        gateway,
      ),
    ).toBeUndefined()
  })

  test("a timeout or provider failure hops to another provider", () => {
    // The same log's earlier hop (13:29:15Z): the free model froze and
    // the router moved to the next provider. Timeout and internal
    // failures keep hopping the same way.
    const stepfun = resolved(free("openrouter", "a-free"))
    expect(nextHopFor(chain, new Set(["openrouter/a-free"]), pool, { type: "provider.timeout" }, stepfun)).toEqual(
      ref("manostech", "auto"),
    )
    expect(nextHopFor(chain, new Set(["openrouter/a-free"]), pool, { type: "provider.internal" }, stepfun)).toEqual(
      ref("manostech", "auto"),
    )
  })

  test("a degraded provider function hops to another provider instead of killing the turn", () => {
    // Gabriel's PDV session (2026-11-11 14:45:40Z): the provider marked
    // the model as degraded and refused to invoke its function; the
    // router did not hop and the session died. The classifier reads a
    // degraded function as a provider-internal failure, so the session
    // error is provider.internal — a hop signal — and the router moves
    // to another provider instead of killing the turn.
    const reason = classifyProviderFailure({
      message: "Function id 'fd21cc19-b4ff-4949-ba07-90dd663c416a': DEGRADED function cannot be invoked",
    })
    const error = toSessionError(new AIError({ reason }))
    expect(error.type).toBe("provider.internal")
    expect(isHopSignal(error)).toBe(true)
    const stepfun = resolved(free("openrouter", "a-free"))
    expect(nextHopFor(chain, new Set(["openrouter/a-free"]), pool, error, stepfun)).toEqual(
      ref("manostech", "auto"),
    )
  })

  test("a degraded provider function with a 4xx status hops to the next model instead of killing the turn", () => {
    // Gabriel's sessions (2026-11-11 20:22:24Z, 3.4.36): the same
    // degraded-function refusal came back with a 400 status, and the
    // classifier ignored server phrasing on 4xx — so the turn died
    // even though the fix was in the build. A degraded function
    // refuses the MODEL, not the request, so the session error stays
    // provider.internal — a hop signal — and the router moves to the
    // next model in the chain (free models first, paid only as a last
    // resort) instead of killing the turn.
    const reason = classifyProviderFailure({
      message: "Function id 'fd21cc19-b4ff-4949-ba07-90dd663c416a': DEGRADED function cannot be invoked",
      status: 400,
    })
    const error = toSessionError(new AIError({ reason }))
    expect(error.type).toBe("provider.internal")
    expect(isHopSignal(error)).toBe(true)
    const stepfun = resolved(free("openrouter", "a-free"))
    expect(nextHopFor(chain, new Set(["openrouter/a-free"]), pool, error, stepfun)).toEqual(
      ref("manostech", "auto"),
    )
  })

  test("a retired model hops to the next model instead of killing the turn", () => {
    // Gabriel's DELIVERY session (2026-11-11 20:25:26Z, 3.4.36): the
    // provider retired the model and the turn died on the 400 instead
    // of hopping to the next model in the chain. A retired model
    // refuses the MODEL, not the request, so the session error is
    // provider.internal — a hop signal — and the router moves to the
    // next model in the chain (free models first, paid only as a last
    // resort) instead of killing the turn.
    const reason = classifyProviderFailure({
      message:
        "This model models/retired-model is no longer available to new users. Please update your code to use models/retired-model for the latest features and improvements.",
      status: 400,
    })
    const error = toSessionError(new AIError({ reason }))
    expect(error.type).toBe("provider.internal")
    expect(isHopSignal(error)).toBe(true)
    const stepfun = resolved(free("openrouter", "a-free"))
    expect(nextHopFor(chain, new Set(["openrouter/a-free"]), pool, error, stepfun)).toEqual(
      ref("manostech", "auto"),
    )
  })

  test("exhaustion takes the next untried model, any provider", () => {
    const stepfun = resolved(free("openrouter", "a-free"))
    expect(
      nextHopFor(chain, new Set(["manostech/auto", "openrouter/a-free"]), pool, { type: "provider.exhausted" }, stepfun),
    ).toEqual(ref("nvidia", "b-free"))
  })

  test("a prompt the model cannot hold hops to a larger window, never to a smaller one", () => {
    const small = resolved(free("openrouter", "small-free", { limit: { context: 32_000, output: 8_000 } }))
    const mid = free("openrouter", "mid-free", { limit: { context: 128_000, output: 32_000 } })
    const big = free("nvidia", "big-free", { limit: { context: 200_000, output: 32_000 } })
    const pool2 = [small, mid, big]
    const chain2 = buildChain(pool2, { complexity: "simple", effort: "automatico" })
    expect(
      nextHopFor(chain2, new Set(["openrouter/small-free"]), pool2, { type: "provider.context-too-long" }, small)?.id,
    ).toBe(Model.ID.make("mid-free"))
    expect(
      nextHopFor(
        chain2,
        new Set(["openrouter/small-free", "openrouter/mid-free"]),
        pool2,
        { type: "provider.context-too-long" },
        small,
      )?.id,
    ).toBe(Model.ID.make("big-free"))
    const bigResolved = resolved(big)
    expect(nextHopFor(chain2, new Set(), pool2, { type: "provider.context-too-long" }, bigResolved)).toBeUndefined()
  })
})

describe("sessionFallback", () => {
  const ref = (providerID: string, id: string) =>
    Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })
  const sessionModel = ref("opencode", "console-model")
  const hopTarget = ref("openrouter", "a-free")

  test("returns the session model when the chain is exhausted on a hop target", () => {
    // Gabriel's order (2026-11-11): when no model is left to try, the
    // session keeps the model it was on and tries it once more instead
    // of dying with the key error.
    expect(sessionFallback(sessionModel, hopTarget, false)).toEqual(sessionModel)
  })

  test("nothing to fall back to when already on the session model", () => {
    expect(sessionFallback(sessionModel, sessionModel, false)).toBeUndefined()
  })

  test("only one fallback per step: after it, there is nothing left", () => {
    expect(sessionFallback(sessionModel, hopTarget, true)).toBeUndefined()
  })

  test("no session model means no fallback", () => {
    expect(sessionFallback(undefined, hopTarget, false)).toBeUndefined()
  })
})
