import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Loader } from "@opencode/ui/loader"
import { For, Show, createSignal, onCleanup, onMount, untrack } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import {
  PROJECT_TRASH_TIMEOUT_MS,
  createProjectTrashState,
  selectProjectTrashView,
  transitionProjectTrash,
  type ProjectTrashEffect,
  type ProjectTrashEvent,
} from "./trash-machine"

export function ProjectTrashDialog(props: { conn: ServerConnection.Any }) {
  const dialog = useDialog()
  const language = useLanguage()
  const global = useGlobal()
  const [trashState, setTrashState] = createSignal(createProjectTrashState())
  let timer: ReturnType<typeof setTimeout> | undefined

  const dispatch = (event: ProjectTrashEvent) => {
    const next = transitionProjectTrash(untrack(trashState), event)

    if (next.state !== untrack(trashState)) setTrashState(next.state)
    next.effects.forEach(run)
  }

  function run(effect: ProjectTrashEffect) {
    if (effect.type === "trash.load") {
      const ctx = global.serverCtx(ServerConnection.key(props.conn))

      if (!ctx) return dispatch({ type: "load.failed", attempt: effect.attempt, cause: undefined })
      const request = Promise.try(() => ctx.sdk.api.project.trash.list())
      void request.then(
        (items) =>
          dispatch({
            type: "load.succeeded",
            attempt: effect.attempt,
            items: items.map((item) => ({
              id: item.id,
              name: item.name,
              directory: item.directory,
              trashedAt: item.trashedAt,
            })),
          }),
        (cause: unknown) => dispatch({ type: "load.failed", attempt: effect.attempt, cause }),
      )

      return
    }

    if (effect.type === "trash.restore") {
      const ctx = global.serverCtx(ServerConnection.key(props.conn))

      if (!ctx) return dispatch({ type: "restore.failed", attempt: effect.attempt, cause: undefined })
      const request = Promise.try(() => ctx.sdk.api.project.trash.restore({ projectID: effect.projectID }))
      void request.then(
        () => dispatch({ type: "restore.succeeded", attempt: effect.attempt, projectID: effect.projectID }),
        (cause: unknown) => dispatch({ type: "restore.failed", attempt: effect.attempt, cause }),
      )

      return
    }

    if (effect.type === "trash.empty") {
      const ctx = global.serverCtx(ServerConnection.key(props.conn))

      if (!ctx) return dispatch({ type: "empty.failed", attempt: effect.attempt, cause: undefined })
      const request = Promise.try(() => ctx.sdk.api.project.trash.empty())
      void request.then(
        () => dispatch({ type: "empty.succeeded", attempt: effect.attempt }),
        (cause: unknown) => dispatch({ type: "empty.failed", attempt: effect.attempt, cause }),
      )

      return
    }

    if (effect.type === "dialog.close") return dialog.close()

    if (effect.type === "toast.load-failed")
      return showToast({
        title: language.t("project.trash.load.failed.title"),
        description:
          effect.cause === undefined
            ? undefined
            : errorMessage(effect.cause, language.t("project.trash.load.failed.title")),
      })

    if (effect.type === "toast.restore-failed")
      return showToast({
        title: language.t("project.trash.restore.failed.title"),
        description:
          effect.cause === undefined
            ? undefined
            : errorMessage(effect.cause, language.t("project.trash.restore.failed.title")),
      })

    if (effect.type === "toast.empty-failed")
      return showToast({
        title: language.t("project.trash.empty.failed.title"),
        description:
          effect.cause === undefined
            ? undefined
            : errorMessage(effect.cause, language.t("project.trash.empty.failed.title")),
      })

    clearTimeout(timer)
    timer = undefined

    if (effect.type === "timer.cancel") return
    timer = setTimeout(() => {
      const state = untrack(trashState)

      if (state.status === "loading") dispatch({ type: "load.timed-out", attempt: effect.attempt })
      if (state.status === "restoring") dispatch({ type: "restore.timed-out", attempt: effect.attempt })
      if (state.status === "emptying") dispatch({ type: "empty.timed-out", attempt: effect.attempt })
    }, PROJECT_TRASH_TIMEOUT_MS)
  }

  onMount(() => dispatch({ type: "load.requested" }))
  onCleanup(() => dispatch({ type: "disposed" }))

  const view = () => selectProjectTrashView(trashState())

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup title={language.t("project.trash.title")} />
      </DialogHeader>
      <Show when={view().loading}>
        <div class="flex items-center justify-center py-8">
          <Loader />
        </div>
      </Show>
      <Show when={!view().loading}>
        <Show when={view().confirmingEmpty}>
          <p class="text-v2-text-text-base">{language.t("project.trash.empty.confirm")}</p>
        </Show>
        <Show when={view().items.length === 0} fallback={
          <div data-scrollable class="flex max-h-[50dvh] min-h-0 flex-col gap-1 overflow-y-auto">
            <For each={view().items}>
              {(item) => (
                <div class="flex min-w-0 items-center gap-2 rounded-[6px] px-1.5 py-1.5 hover:bg-v2-background-bg-layer-01">
                  <span class="flex min-w-0 flex-1 flex-col leading-[var(--line-height-compact)]">
                    <span class="truncate text-v2-text-text-base">{item.name ?? item.directory}</span>
                    <Show when={item.name}>
                      <span class="truncate font-mono text-[13px] text-v2-text-text-muted">{item.directory}</span>
                    </Show>
                  </span>
                  <Button
                    variant="neutral"
                    size="small"
                    disabled={view().busy || view().confirmingEmpty}
                    aria-busy={view().restoringID === item.id}
                    onClick={() => dispatch({ type: "restore.requested", projectID: item.id })}
                  >
                    <Show when={view().restoringID === item.id}>
                      <Loader class="size-3.5" />
                    </Show>
                    {language.t("project.trash.restore")}
                  </Button>
                </div>
              )}
            </For>
          </div>
        }>
          <p class="text-v2-text-text-muted">{language.t("project.trash.empty")}</p>
        </Show>
      </Show>
      <DialogFooter>
        <Show
          when={view().confirmingEmpty}
          fallback={
            <>
              <Button variant="ghost" disabled={!view().canClose} onClick={() => dispatch({ type: "close.requested" })}>
                {language.t("common.close")}
              </Button>
              <Button
                variant="danger"
                disabled={view().busy || view().items.length === 0}
                onClick={() => dispatch({ type: "empty.requested" })}
              >
                {language.t("project.trash.empty.button")}
              </Button>
            </>
          }
        >
          <Button variant="ghost" disabled={!view().canClose} onClick={() => dispatch({ type: "empty.cancel.requested" })}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="danger" disabled={view().busy} onClick={() => dispatch({ type: "empty.confirmed" })}>
            {language.t("project.trash.empty.button")}
          </Button>
        </Show>
      </DialogFooter>
    </Dialog>
  )
}
