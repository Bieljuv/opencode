import type { ClientUsage, WeeklyUsage } from "@opencode/plugin/gui"

/**
 * ManosTech: o medidor do plano SEMANAL na aba Contexto. A barra é a mesma
 * da diária (10 blocos, tons verde <70% / amarelo 70–89% / vermelho 90%+),
 * lida do `semanal` de GET /api/uso. Só a % e os instantes chegam à
 * interface — nunca a contagem de tokens nem o tamanho do limite.
 *
 * As funções de tom e blocos espelham `planUsageTone`, `planUsageBlocks` e
 * `planUsageToneClass` em `packages/app/src/client/plan-usage.tsx` (os
 * mesmos limites e os mesmos 10 blocos); se os limites mudarem lá, mudam
 * aqui.
 */

export type WeeklyUsageTone = "ok" | "warn" | "danger"

/** Verde <70%, amarelo 70–89%, vermelho 90%+. */
export function weeklyUsageTone(percent: number): WeeklyUsageTone {
  if (percent >= 90) return "danger"
  if (percent >= 70) return "warn"
  return "ok"
}

/** Blocos preenchidos da barra de 10. */
export function weeklyUsageBlocks(percent: number): number {
  return Math.min(10, Math.max(0, Math.round(percent / 10)))
}

/**
 * Tom → classe de fundo dos blocos. Usa as cores de estado SATURADAS
 * (`--v2-state-fg-*`): as de fundo (`--v2-state-bg-*`) são tintas pálidas
 * e somem num bloco de 8px.
 */
export function weeklyUsageToneClass(tone: WeeklyUsageTone): string {
  if (tone === "danger") return "bg-v2-state-fg-danger"
  if (tone === "warn") return "bg-v2-state-fg-warning"
  return "bg-v2-state-fg-success"
}

/** Milissegundos até o reset; undefined quando o instante não parseia. */
export function weeklyUsageResetInMs(resetsAt: string, nowMs: number): number | undefined {
  const at = Date.parse(resetsAt)

  if (!Number.isFinite(at)) return undefined

  return Math.max(0, at - nowMs)
}

/** Divide o tempo até o reset em dias, horas e minutos para o rótulo. */
export function weeklyUsageResetParts(ms: number): { days: number; hours: number; minutes: number } {
  return {
    days: Math.floor(ms / 86_400_000),
    hours: Math.floor((ms % 86_400_000) / 3_600_000),
    minutes: Math.floor((ms % 3_600_000) / 60_000),
  }
}

/** O uso semanal da conta, ou undefined quando o painel não reporta limite semanal — a barra some. */
export function selectWeeklyUsage(usage: ClientUsage | undefined): WeeklyUsage | undefined {
  return usage?.weekly
}

/** O instante da liberação, só enquanto o uso semanal está bloqueado. */
export function selectWeeklyRelease(weekly: WeeklyUsage | undefined): string | undefined {
  if (!weekly?.blocked) return undefined

  return weekly.releasesAt
}
