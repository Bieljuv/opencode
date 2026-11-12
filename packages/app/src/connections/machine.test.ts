import { describe, expect, test } from "bun:test"
import {
  cardError,
  cardNotice,
  initialConnectionsPanelState,
  isCardBusy,
  transition,
  type ConnectionsPanelState,
} from "./machine"

const loaded = () =>
  transition(initialConnectionsPanelState, {
    type: "loaded",
    statuses: [
      { provider: "github", connected: true, login: "gabriel", permission: "ask" },
      { provider: "vercel", connected: false, permission: "ask" },
      { provider: "supabase", connected: false, permission: "block" },
    ],
  })

describe("connections panel machine", () => {
  test("loaded abre o painel com os três cartões no estado guardado", () => {
    const state = loaded()

    expect(state.status).toBe("ready")
    if (state.status !== "ready") return
    expect(state.cards.github).toEqual({ phase: "idle", connected: true, login: "gabriel", permission: "ask" })
    expect(state.cards.vercel).toEqual({ phase: "idle", connected: false, permission: "ask" })
    expect(state.cards.supabase).toEqual({ phase: "idle", connected: false, permission: "block" })
  })

  test("load-failed mostra o erro e retry-load volta a carregar", () => {
    const failed = transition(initialConnectionsPanelState, { type: "load-failed" })

    expect(failed.status).toBe("load-failed")
    expect(transition(failed, { type: "retry-load" })).toEqual({ status: "loading" })
    const ready = loaded()
    expect(transition(ready, { type: "load-failed" })).toBe(ready)
  })

  test("salvar: ocupado, depois conectado com o nome da conta", () => {
    const ready = loaded()
    const busy = transition(ready, { type: "save-started", provider: "vercel", attempt: "a1" })

    expect(busy.status).toBe("ready")
    if (busy.status !== "ready") return
    expect(isCardBusy(busy.cards.vercel)).toBe(true)
    expect(busy.cards.vercel.phase).toBe("busy")

    const saved = transition(busy, { type: "saved", provider: "vercel", attempt: "a1", login: "manostech" })

    expect(saved.status).toBe("ready")
    if (saved.status !== "ready") return
    expect(saved.cards.vercel).toEqual({
      phase: "idle",
      connected: true,
      login: "manostech",
      permission: "ask",
      notice: "saved",
    })
    expect(cardNotice(saved.cards.vercel)).toBe("saved")
  })

  test("resultado atrasado (tentativa antiga) é ignorado", () => {
    const ready = loaded()
    const busy = transition(ready, { type: "save-started", provider: "vercel", attempt: "a1" })

    expect(transition(busy, { type: "saved", provider: "vercel", attempt: "a0", login: "outro" })).toBe(busy)
    expect(transition(busy, { type: "save-failed", provider: "vercel", attempt: "a0" })).toBe(busy)
  })

  test("salvar com token rejeitado mostra o erro e permite tentar de novo", () => {
    const ready = loaded()
    const busy = transition(ready, { type: "save-started", provider: "vercel", attempt: "a1" })
    const failed = transition(busy, { type: "save-failed", provider: "vercel", attempt: "a1" })

    expect(failed.status).toBe("ready")
    if (failed.status !== "ready") return
    expect(cardError(failed.cards.vercel)).toBe("save-failed")
    expect(transition(failed, { type: "save-started", provider: "vercel", attempt: "a2" }).status).toBe("ready")
  })

  test("testar: ocupado, depois aviso de funcionando; falha mostra o erro de teste", () => {
    const ready = loaded()
    const busy = transition(ready, { type: "test-started", provider: "github", attempt: "a1" })
    const tested = transition(busy, { type: "tested", provider: "github", attempt: "a1", login: "gabriel" })

    expect(tested.status).toBe("ready")
    if (tested.status !== "ready") return
    expect(cardNotice(tested.cards.github)).toBe("tested")

    const busyAgain = transition(tested, { type: "test-started", provider: "github", attempt: "a2" })
    const failed = transition(busyAgain, { type: "test-failed", provider: "github", attempt: "a2" })

    expect(failed.status).toBe("ready")
    if (failed.status !== "ready") return
    expect(cardError(failed.cards.github)).toBe("test-failed")
  })

  test("desconectar: ocupado, depois desconectado com a permissão no padrão", () => {
    const ready = loaded()
    const busy = transition(ready, { type: "disconnect-started", provider: "github", attempt: "a1" })
    const done = transition(busy, { type: "disconnected", provider: "github", attempt: "a1" })

    expect(done.status).toBe("ready")
    if (done.status !== "ready") return
    expect(done.cards.github).toEqual({ phase: "idle", connected: false, permission: "ask" })
  })

  test("segunda operação com o cartão ocupado é ignorada (mesmo objeto)", () => {
    const ready = loaded()
    const busy = transition(ready, { type: "save-started", provider: "vercel", attempt: "a1" })

    expect(transition(busy, { type: "test-started", provider: "vercel", attempt: "a2" })).toBe(busy)
    expect(transition(busy, { type: "disconnect-started", provider: "vercel", attempt: "a2" })).toBe(busy)
  })

  test("permissão muda no cartão parado e é ignorada com o cartão ocupado", () => {
    const ready = loaded()
    const changed = transition(ready, { type: "permission-changed", provider: "supabase", permission: "allow" })

    expect(changed.status).toBe("ready")
    if (changed.status !== "ready") return
    expect(changed.cards.supabase.permission).toBe("allow")

    const busy = transition(changed, { type: "test-started", provider: "supabase", attempt: "a1" })

    expect(transition(busy, { type: "permission-changed", provider: "supabase", permission: "ask" })).toBe(busy)
  })

  test("refreshed troca os cartões parados e é ignorado com algum cartão ocupado", () => {
    const ready = loaded()
    const refreshed = transition(ready, {
      type: "refreshed",
      statuses: [
        { provider: "github", connected: false, permission: "ask" },
        { provider: "vercel", connected: true, login: "manostech", permission: "allow" },
        { provider: "supabase", connected: false, permission: "ask" },
      ],
    })

    expect(refreshed.status).toBe("ready")
    if (refreshed.status !== "ready") return
    expect(refreshed.cards.github.connected).toBe(false)
    expect(refreshed.cards.vercel).toEqual({
      phase: "idle",
      connected: true,
      login: "manostech",
      permission: "allow",
    })

    const busy = transition(refreshed, { type: "save-started", provider: "github", attempt: "a1" })

    expect(
      transition(busy, {
        type: "refreshed",
        statuses: [{ provider: "github", connected: true, permission: "ask" }],
      }),
    ).toBe(busy)
  })

  test("refreshed com os mesmos estados mantém o aviso e o erro do cartão", () => {
    const ready = loaded()
    const busy = transition(ready, { type: "save-started", provider: "vercel", attempt: "a1" })
    const saved = transition(busy, { type: "saved", provider: "vercel", attempt: "a1", login: "manostech" })
    const same = [
      { provider: "github", connected: true, login: "gabriel", permission: "ask" },
      { provider: "vercel", connected: true, login: "manostech", permission: "ask" },
      { provider: "supabase", connected: false, permission: "block" },
    ] as const
    const kept = transition(saved, { type: "refreshed", statuses: [...same] })

    expect(kept).toBe(saved)
    if (kept.status !== "ready") return
    expect(cardNotice(kept.cards.vercel)).toBe("saved")

    const failed = transition(
      transition(saved, { type: "save-started", provider: "vercel", attempt: "a2" }),
      { type: "save-failed", provider: "vercel", attempt: "a2" },
    )
    const keptFailed = transition(failed, { type: "refreshed", statuses: [...same] })

    expect(keptFailed).toBe(failed)
    if (keptFailed.status !== "ready") return
    expect(cardError(keptFailed.cards.vercel)).toBe("save-failed")
  })

  test("disposed neutraliza a máquina e os eventos seguintes não fazem nada", () => {
    const ready = loaded()
    const disposed: ConnectionsPanelState = transition(ready, { type: "disposed" })

    expect(disposed.status).toBe("disposed")
    expect(transition(disposed, { type: "save-started", provider: "github", attempt: "a1" })).toBe(disposed)
    expect(transition(disposed, { type: "loaded", statuses: [] })).toBe(disposed)
  })
})
