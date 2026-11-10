import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import type { ClientUsage, WeeklyUsage } from "@opencode/plugin/gui"
import { usePlugin } from "@opencode/plugin/gui"
import {
  selectWeeklyRelease,
  selectWeeklyUsage,
  weeklyUsageBlocks,
  weeklyUsageResetInMs,
  weeklyUsageResetParts,
  weeklyUsageTone,
  weeklyUsageToneClass,
} from "./weekly-usage"

const POLL_MS = 60_000

/** A barra do plano semanal: os mesmos 10 blocos e tons da barra diária, só com a % e os instantes. */
export function WeeklyUsageBar(props: { weekly: WeeklyUsage; time: (value: number | undefined) => string }) {
  const ctx = usePlugin()
  const tone = () => weeklyUsageTone(props.weekly.percent)
  const filled = () => weeklyUsageBlocks(props.weekly.percent)
  const percent = () => Math.round(props.weekly.percent)

  const resetLabel = () => {
    const remaining = weeklyUsageResetInMs(props.weekly.resetsAt, Date.now())

    if (remaining === undefined) return undefined

    const { days, hours, minutes } = weeklyUsageResetParts(remaining)

    if (days > 0) return ctx.plural("weeklyUsage.resetsInDays", days)
    if (hours > 0)
      return ctx.t("weeklyUsage.resetsInHours", { hours: String(hours), minutes: String(minutes) })

    return ctx.t("weeklyUsage.resetsInMinutes", { minutes: String(minutes) })
  }

  const releaseLabel = () => {
    const releasesAt = selectWeeklyRelease(props.weekly)

    if (releasesAt === undefined) return undefined

    const at = Date.parse(releasesAt)

    if (!Number.isFinite(at)) return undefined

    return ctx.t("weeklyUsage.releasesAt", { time: props.time(at) })
  }

  return (
    <div class="flex flex-col gap-1" data-slot="weekly-plan-usage">
      <div
        class="flex items-center gap-2 text-12-regular"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent()}
        aria-label={ctx.t("weeklyUsage.title")}
      >
        <span class="text-text-weak shrink-0">{ctx.t("weeklyUsage.title")}</span>
        <div class="flex min-w-0 flex-1 gap-[2px]" aria-hidden>
          <For each={Array.from({ length: 10 }, (_, index) => index < filled())}>
            {(on) => (
              <span class={`h-2 flex-1 rounded-full ${weeklyUsageToneClass(tone())} ${on ? "" : "opacity-20"}`} />
            )}
          </For>
        </div>
        <span class="shrink-0 text-12-medium">{percent()}%</span>
        <Show when={resetLabel()}>
          {(label) => <span class="text-text-weak shrink-0">{label()}</span>}
        </Show>
      </div>
      <Show when={releaseLabel()}>
        {(label) => <p class="text-12-regular text-text-weak">{label()}</p>}
      </Show>
    </div>
  )
}

/** A seção do plano semanal na aba Contexto: busca o uso no painel e some sem limite semanal. */
export function WeeklyUsageSection(props: { time: (value: number | undefined) => string }) {
  const ctx = usePlugin()
  const [usage, setUsage] = createSignal<ClientUsage | undefined>(undefined)

  const load = async () => {
    const getClientUsage = ctx.clientUsage

    if (!getClientUsage) return

    const value = await getClientUsage().catch(() => undefined)

    if (ctx.signal.aborted) return

    if (!value) return

    setUsage(value)
  }

  onMount(() => {
    void load()

    const timer = setInterval(() => void load(), POLL_MS)

    onCleanup(() => clearInterval(timer))
  })

  return (
    <Show when={selectWeeklyUsage(usage())} keyed>
      {(weekly) => <WeeklyUsageBar weekly={weekly} time={props.time} />}
    </Show>
  )
}
