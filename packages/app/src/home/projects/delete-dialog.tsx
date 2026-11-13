import { containsDirectory } from "@opencode/util/path"
import { displayName } from "@opencode/ui/project-avatar"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { createSignal, onCleanup, untrack } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { ServerConnection } from "@/runtime/server/registry"
import { useGlobal } from "@/runtime/server/runtime"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"
import type { LocalProject } from "@/shell/state/layout"
import { notifySessionTabsRemoved } from "@/shell/titlebar/session-events"
import {
  createProjectDeleteState,
  PROJECT_DELETE_TIMEOUT_MS,
  selectProjectDeleteView,
  transitionProjectDelete,
  type ProjectDeleteEffect,
  type ProjectDeleteEvent,
  type ProjectDeleteTarget,
} from "./delete-machine"

export function ProjectDeleteDialog(props: { conn: ServerConnection.Any; project: LocalProject }) {
  const dialog = useDialog()
  const language = useLanguage()
  const global = useGlobal()
  const name = () => displayName(props.project)
  const [deleteState, setDeleteState] = createSignal(createProjectDeleteState())
  let timer: ReturnType<typeof setTimeout> | undefined

  const dispatch = (event: ProjectDeleteEvent) => {
    const next = transitionProjectDelete(untrack(deleteState), event)

    if (next.state !== untrack(deleteState)) setDeleteState(next.state)
    next.effects.forEach(run)
  }

  // Read when the user confirms, before the delete closes the project's tabs.
  const deleteTarget = (): ProjectDeleteTarget | undefined => {
    const ctx = global.serverCtx(ServerConnection.key(props.conn))

    if (!ctx || !props.project.id) return undefined
    const directories = [props.project.worktree, ...(props.project.sandboxes ?? [])]
    const sessionIDs = ctx.data.session
      .list()
      .filter((item) => directories.some((directory) => containsDirectory(directory, item.location.directory)))
      .map((item) => item.id)

    return { projectID: props.project.id, sessionIDs }
  }

  function run(effect: ProjectDeleteEffect) {
    if (effect.type === "delete.run") {
      const ctx = global.serverCtx(ServerConnection.key(props.conn))

      if (!ctx) return dispatch({ type: "delete.failed", attempt: effect.attempt, cause: undefined })
      const request = Promise.try(() => ctx.sdk.api.project.delete({ projectID: effect.target.projectID }))
      void request.then(
        () => dispatch({ type: "delete.succeeded", attempt: effect.attempt, target: effect.target }),
        (cause: unknown) => dispatch({ type: "delete.failed", attempt: effect.attempt, cause }),
      )

      return
    }

    if (effect.type === "dialog.close") return dialog.close()

    if (effect.type === "project.removed") {
      const ctx = global.serverCtx(ServerConnection.key(props.conn))

      ctx?.projects.hide(props.project)
      notifySessionTabsRemoved({
        server: ServerConnection.key(props.conn),
        directory: props.project.worktree,
        sessionIDs: [...effect.target.sessionIDs],
      })

      return
    }

    if (effect.type === "toast.delete-failed")
      return showToast({
        title: language.t("project.delete.failed.title"),
        description:
          effect.cause === undefined
            ? undefined
            : errorMessage(effect.cause, language.t("project.delete.failed.title")),
      })

    clearTimeout(timer)
    timer = undefined

    if (effect.type === "timer.cancel") return
    timer = setTimeout(
      () => dispatch({ type: "delete.timed-out", attempt: effect.attempt }),
      PROJECT_DELETE_TIMEOUT_MS,
    )
  }

  onCleanup(() => dispatch({ type: "disposed" }))
  const busy = () => selectProjectDeleteView(deleteState()).busy

  return (
    <Dialog fit>
      <DialogHeader hideClose>
        <DialogTitleGroup
          title={language.t("project.delete.title")}
          description={
            <>
              {language.t("project.delete.confirm", { name: name() })}
              <span class="mt-2 block break-all font-mono text-[13px]">{props.project.worktree}</span>
            </>
          }
        />
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" autofocus disabled={busy()} onClick={() => dispatch({ type: "cancel.requested" })}>
          {language.t("common.cancel")}
        </Button>
        <Button
          variant="danger"
          disabled={busy()}
          onClick={() => dispatch({ type: "confirm.requested", target: deleteTarget() })}
        >
          {language.t("project.delete.button")}
        </Button>
      </DialogFooter>
    </Dialog>
  )
}
