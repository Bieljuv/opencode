import { createMemo, Show } from "solid-js"
import type { SessionStatus } from "@opencode/client/promise"
import { useI18n } from "@opencode/ui/context/i18n"
import { Card } from "@opencode/ui/card"
import { Icon } from "@opencode/ui/icon"
import { TextShimmer } from "@opencode/ui/text-shimmer"

export function SessionRetry(props: { status: SessionStatus; show?: boolean }) {
  const i18n = useI18n()

  const retry = createMemo(() => {
    if (props.status.type !== "retry") return

    return props.status
  })

  return (
    <Show when={retry() && (props.show ?? true)}>
      <div data-slot="session-turn-retry" class="w-full min-w-0">
        <Card variant="error" class="error-card" data-kind="session-retry-card">
          <div class="flex w-full items-start gap-2">
            <Icon name="outline-hexagonal-warning" class="shrink-0 text-v2-state-fg-danger" />
            <div class="min-w-0 flex-1">
              {/* The provider's error message never shows here: it can name the model or its limits.
                  Neither do the attempt count or the countdown: they would narrate the route
                  retries happening underneath. The card says only that it is retrying. */}
              <div data-slot="session-turn-retry-info">
                <TextShimmer text={i18n.t("ui.sessionTurn.retry.retrying")} active />
              </div>
            </div>
          </div>
        </Card>
      </div>
    </Show>
  )
}
