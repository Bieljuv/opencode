import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { MonthlyUsage, WeeklyUsage } from "@opencode/plugin/gui"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"

/**
 * ManosTech: uso diário do plano, no padrão do `/usage` do Claude Code,
 * adaptado — uma só janela DIÁRIA (reseta à meia-noite, America/Sao_Paulo),
 * sem contagem de tokens e sem tamanho absoluto da cota: só % + hora do
 * reset. A barra é neutra: nunca nomeia modelo, provedor, grátis/pago,
 * limite, cota ou roteamento. Sem dados (gateway inativo ou painel fora
 * do ar), nada renderiza — sem estado vazio, sem erro.
 *
 * A barra vive só na tela de uso sob demanda, na seção Conta das
 * Configurações. A tira persistente do rodapé da sessão saiu: ela media
 * só o uso do gateway contra o limite diário, e marcava 0% com milhões
 * de tokens gastos nos modelos diretos — o número certo é o total do
 * dia, que a aba Contexto mostra. O aviso dos 75% continua: um
 * observador sem interface na raiz do app (PlanUsageWatcher) dispara o
 * push do sistema uma vez por dia (e o aviso semanal, uma vez por
 * ciclo), no mesmo gatilho de antes — o main guarda o dia avisado (e o
 * ciclo avisado) e o push só sai enquanto ele não foi marcado.
 *
 * A trava do compositor lê o mesmo estado: `planBlock` devolve o
 * bloqueio ativo (diário, semanal ou mensal) com a liberação mais
 * distante — o compositor trava enquanto houver qualquer bloqueio e
 * destrava no próximo poll (60s) quando todos limparem.
 */

export type PlanUsage = {
  readonly percent: number
  readonly resetsAt: string
  readonly warnedToday: boolean
  /** True enquanto o uso diário atingiu o limite e o cliente espera a meia-noite. */
  readonly blocked: boolean
  /** O uso semanal, quando o painel o reporta; ausente = sem limite semanal, a barra some. */
  readonly weekly?: WeeklyUsage
  /** O uso mensal, quando o painel o reporta; ausente = sem limite mensal. */
  readonly monthly?: MonthlyUsage
  /** O aviso semanal dos 75% já apareceu neste ciclo (o main guarda o ciclo avisado). */
  readonly weeklyWarned: boolean
}

/**
 * O bloqueio ativo do plano, quando há um: diário, semanal ou mensal.
 * `releasesAt` é a liberação MAIS DISTANTE entre os bloqueios ativos —
 * o compositor só destrava quando todos limparem. Undefined = nenhum
 * bloqueio, o compositor segue normal.
 */
export type PlanBlock = {
  readonly releasesAt: string
}

export function planBlock(usage: PlanUsage): PlanBlock | undefined {
  const releases = [
    usage.blocked ? usage.resetsAt : undefined,
    usage.weekly?.blocked ? (usage.weekly.releasesAt ?? usage.weekly.resetsAt) : undefined,
    usage.monthly?.blocked ? (usage.monthly.releasesAt ?? usage.monthly.resetsAt) : undefined,
  ].filter((at): at is string => at !== undefined)

  if (releases.length === 0) return undefined

  return { releasesAt: releases.reduce((latest, at) => (at > latest ? at : latest), releases[0]) }
}

export type PlanUsageTone = "ok" | "warn" | "danger"

/** Verde <70%, amarelo 70–89%, vermelho 90%+. */
export function planUsageTone(percent: number): PlanUsageTone {
  if (percent >= 90) return "danger"

  if (percent >= 70) return "warn"

  return "ok"
}

/** Blocos preenchidos da barra de 10. */
export function planUsageBlocks(percent: number): number {
  return Math.min(10, Math.max(0, Math.round(percent / 10)))
}

/** Milissegundos até o reset; undefined quando o instante não parseia. */
export function planUsageResetInMs(resetsAt: string, nowMs: number): number | undefined {
  const at = Date.parse(resetsAt)

  if (!Number.isFinite(at)) return undefined

  return Math.max(0, at - nowMs)
}

function resetParts(ms: number) {
  return { hours: Math.floor(ms / 3_600_000), minutes: Math.floor((ms % 3_600_000) / 60_000) }
}

/**
 * Tom → classe de fundo dos blocos. Usa as cores de estado SATURADAS
 * (`--v2-state-fg-*`, as mesmas dos pontos de status e da faixa do
 * callout de uso): as de fundo (`--v2-state-bg-*`) são tintas pálidas
 * para painéis de callout e somem num bloco de 8px. As três existem
 * como `--color-v2-state-fg-*` em `@theme`
 * (`packages/ui/src/styles/tailwind/colors.css`), então o Tailwind
 * gera a regra — `bg-success` / `bg-warning` / `bg-danger` não tinham
 * token nenhum e computavam transparente (blocos invisíveis).
 */
export function planUsageToneClass(tone: PlanUsageTone): string {
  if (tone === "danger") return "bg-v2-state-fg-danger"

  if (tone === "warn") return "bg-v2-state-fg-warning"

  return "bg-v2-state-fg-success"
}

const WARNING_PERCENT = 75

/** O aviso dos 75% dispara: no observador (showWarning), com uso >= 75% e sem aviso hoje. */
export function shouldShowUsageWarning(usage: PlanUsage, showWarning?: boolean): boolean {
  return showWarning === true && usage.percent >= WARNING_PERCENT && !usage.warnedToday
}

/** O aviso semanal dos 75% dispara: no observador, com o uso da semana >= 75% e sem aviso neste ciclo. */
export function shouldShowWeeklyUsageWarning(usage: PlanUsage, showWarning?: boolean): boolean {
  const weekly = usage.weekly

  return showWarning === true && weekly !== undefined && weekly.percent >= WARNING_PERCENT && !usage.weeklyWarned
}

export function PlanUsageBar(props: { usage: PlanUsage }) {
  const language = useLanguage()
  const tone = () => planUsageTone(props.usage.percent)
  const filled = () => planUsageBlocks(props.usage.percent)
  const percent = () => Math.round(props.usage.percent)

  const resetLabel = () => {
    const remaining = planUsageResetInMs(props.usage.resetsAt, Date.now())

    if (remaining === undefined) return undefined

    const { hours, minutes } = resetParts(remaining)

    return hours > 0
      ? language.t("client.usage.resetsInHours", { hours: String(hours), minutes: String(minutes) })
      : language.t("client.usage.resetsInMinutes", { minutes: String(minutes) })
  }

  return (
    <div class="flex flex-col gap-1 py-1" data-slot="plan-usage">
      <div
        class="flex items-center gap-2 text-[13px] leading-[var(--line-height-compact)]"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent()}
        aria-label={language.t("client.usage.today")}
      >
        <span class="text-muted shrink-0">{language.t("client.usage.today")}</span>
        <div class="flex min-w-0 flex-1 gap-[2px]" aria-hidden>
          <For each={Array.from({ length: 10 }, (_, index) => index < filled())}>
            {(on) => <span class={`h-2 flex-1 rounded-full ${planUsageToneClass(tone())} ${on ? "" : "opacity-20"}`} />}
          </For>
        </div>
        <span class="shrink-0 font-medium">{percent()}%</span>
        <Show when={resetLabel()}>
          {(label) => <span class="text-muted shrink-0">{label()}</span>}
        </Show>
      </div>
    </div>
  )
}

/** O uso diário do main, com refresh periódico; undefined sem gateway ou sem dados. */
export function useClientUsage() {
  const platform = usePlatform()
  const [usage, setUsage] = createSignal<PlanUsage | undefined>(undefined)

  const load = () => {
    if (!platform.getClientUsage) return

    void platform
      .getClientUsage()
      .then((value) => setUsage(value ?? undefined))
      .catch(() => undefined)
  }

  onMount(() => {
    load()
    const timer = setInterval(load, 60_000)
    const off = platform.onClientChanged?.(() => load())

    onCleanup(() => {
      clearInterval(timer)
      off?.()
    })
  })

  return usage
}

/**
 * Os avisos dos 75% sem interface: montado uma vez na raiz do app,
 * observa o uso do plano (a mesma consulta de 60s da tira antiga) e
 * dispara o push do sistema uma vez por dia (diário) e uma vez por
 * ciclo (semanal), quando o uso cruza os 75%. O push só aparece com
 * a janela desfocada; focada, nada mostra — a barra da seção Conta
 * segue como o lugar onde o % pode ser conferido. Uma vez por dia /
 * por ciclo: o push só sai enquanto warnedToday / weeklyWarned é
 * falso, e a marcação abaixo desliga o aviso no próximo carregamento.
 * O mensal não tem push para o cliente: o aviso mensal é do admin,
 * no Dashboard do painel.
 */
export function PlanUsageWatcher() {
  const platform = usePlatform()
  const language = useLanguage()
  const usage = useClientUsage()

  createEffect(() => {
    const value = usage()

    if (!value || !shouldShowUsageWarning(value, true)) return

    void platform.markClientUsageWarned?.()
    void platform.notify(
      language.t("client.usage.warningPush.title"),
      language.t("client.usage.warningPush.body", { percent: String(Math.round(value.percent)) }),
    )
  })

  createEffect(() => {
    const value = usage()

    if (!value || !shouldShowWeeklyUsageWarning(value, true)) return

    void platform.markWeeklyUsageWarned?.()
    void platform.notify(
      language.t("client.usage.weeklyWarningPush.title"),
      language.t("client.usage.weeklyWarningPush.body", {
        percent: String(Math.round(value.weekly?.percent ?? 0)),
      }),
    )
  })

  return null
}
