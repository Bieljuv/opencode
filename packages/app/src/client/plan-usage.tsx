import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { WeeklyUsage } from "@opencode/plugin/gui"
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
 * dia, que a aba Contexto mostra. O aviso dos 85% continua: um
 * observador sem interface na raiz do app (PlanUsageWatcher) dispara o
 * push do sistema uma vez por dia, no mesmo gatilho de antes — o main
 * guarda o dia avisado e o push só sai enquanto ele não foi marcado.
 */

export type PlanUsage = {
  readonly percent: number
  readonly resetsAt: string
  readonly warnedToday: boolean
  /** O uso semanal, quando o painel o reporta; ausente = sem limite semanal, a barra some. */
  readonly weekly?: WeeklyUsage
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

const WARNING_PERCENT = 85

/** O aviso dos 85% dispara: no observador (showWarning), com uso >= 85% e sem aviso hoje. */
export function shouldShowUsageWarning(usage: PlanUsage, showWarning?: boolean): boolean {
  return showWarning === true && usage.percent >= WARNING_PERCENT && !usage.warnedToday
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
 * O aviso dos 85% sem interface: montado uma vez na raiz do app, observa
 * o uso do plano (a mesma consulta de 60s da tira antiga) e dispara o
 * push do sistema uma vez por dia, quando o uso cruza os 85%. O push só
 * aparece com a janela desfocada; focada, nada mostra — a barra da
 * seção Conta segue como o lugar onde o % pode ser conferido. Uma vez
 * por dia: o push só sai enquanto warnedToday é falso, e a marcação
 * abaixo desliga o aviso no próximo carregamento.
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

  return null
}
