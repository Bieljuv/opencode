type DurationKey =
  | "ui.message.duration.seconds"
  | "ui.message.duration.minutesSeconds"
  | "ui.message.duration.hoursMinutes"

// 12s, 1m 05s, 1h 02m: the trailing unit is padded so ticking keeps the same digit count.
export function formatElapsed(ms: number, t: (key: DurationKey, params: Record<string, string>) => string) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, "0")

  if (total < 60) return t("ui.message.duration.seconds", { count: String(total) })

  if (total < 3600)
    return t("ui.message.duration.minutesSeconds", {
      minutes: String(Math.floor(total / 60)),
      seconds: pad(total % 60),
    })

  return t("ui.message.duration.hoursMinutes", {
    hours: String(Math.floor(total / 3600)),
    minutes: pad(Math.floor(total / 60) % 60),
  })
}
