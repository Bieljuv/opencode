import type { ServerConnection } from "@/runtime/server/registry"
import type { LocalProject } from "@/shell/state/layout"

/**
 * Deleting a project that is not in the list: pick its folder, register it so the
 * server can delete it by ID, then run the same confirm dialog and trash flow as a
 * listed delete. A cancel must leave the list exactly as it was: a folder the client
 * had never used goes back to unlisted (hidden), never stays registered-and-listed.
 */
export type ProjectDeleteOldState =
  | { readonly status: "idle"; readonly attempt: number }
  | { readonly status: "picking"; readonly attempt: number; readonly conn: ServerConnection.Any }
  | {
      readonly status: "resolving"
      readonly attempt: number
      readonly conn: ServerConnection.Any
      readonly directory: string
    }
  | {
      readonly status: "confirming"
      readonly attempt: number
      readonly conn: ServerConnection.Any
      readonly directory: string
      readonly project: LocalProject
      readonly wasUsed: boolean
    }
  | { readonly status: "disposed"; readonly attempt: number }

export type ProjectDeleteOldEvent =
  | { readonly type: "deleteOld.requested"; readonly conn: ServerConnection.Any }
  | { readonly type: "picker.closed"; readonly attempt: number; readonly directory: string | undefined }
  | {
      readonly type: "add.succeeded"
      readonly attempt: number
      readonly project: LocalProject
      readonly wasUsed: boolean
    }
  | { readonly type: "add.failed"; readonly attempt: number }
  | { readonly type: "dialog.closed"; readonly attempt: number; readonly deleted: boolean }
  | { readonly type: "disposed" }

export type ProjectDeleteOldEffect =
  | { readonly type: "picker.open"; readonly attempt: number; readonly conn: ServerConnection.Any }
  | {
      readonly type: "project.add"
      readonly attempt: number
      readonly conn: ServerConnection.Any
      readonly directory: string
    }
  | {
      readonly type: "dialog.open"
      readonly attempt: number
      readonly conn: ServerConnection.Any
      readonly project: LocalProject
      readonly directory: string
      readonly wasUsed: boolean
    }
  | {
      readonly type: "project.hide"
      readonly attempt: number
      readonly conn: ServerConnection.Any
      readonly project: LocalProject
    }

export type ProjectDeleteOldTransition = {
  readonly state: ProjectDeleteOldState
  readonly effects: readonly ProjectDeleteOldEffect[]
}

const NO_EFFECTS: readonly never[] = Object.freeze([])

export function createProjectDeleteOldState(): ProjectDeleteOldState {
  return { status: "idle", attempt: 0 }
}

export function transitionProjectDeleteOld(
  state: ProjectDeleteOldState,
  event: ProjectDeleteOldEvent,
): ProjectDeleteOldTransition {
  if (state.status === "disposed") return { state, effects: NO_EFFECTS }
  if (event.type === "disposed")
    return { state: { status: "disposed", attempt: state.attempt + 1 }, effects: NO_EFFECTS }

  if (event.type === "deleteOld.requested") {
    if (state.status !== "idle") return { state, effects: NO_EFFECTS }
    const attempt = state.attempt + 1
    return {
      state: { status: "picking", attempt, conn: event.conn },
      effects: [{ type: "picker.open", attempt, conn: event.conn }],
    }
  }

  if ("attempt" in event && event.attempt !== state.attempt) return { state, effects: NO_EFFECTS }
  if (state.status === "idle") return { state, effects: NO_EFFECTS }

  if (state.status === "picking") {
    if (event.type !== "picker.closed") return { state, effects: NO_EFFECTS }
    if (event.directory === undefined)
      return { state: { status: "idle", attempt: state.attempt }, effects: NO_EFFECTS }
    return {
      state: { status: "resolving", attempt: state.attempt, conn: state.conn, directory: event.directory },
      effects: [{ type: "project.add", attempt: state.attempt, conn: state.conn, directory: event.directory }],
    }
  }

  if (state.status === "resolving") {
    if (event.type === "add.failed")
      return { state: { status: "idle", attempt: state.attempt }, effects: NO_EFFECTS }
    if (event.type !== "add.succeeded") return { state, effects: NO_EFFECTS }
    return {
      state: {
        status: "confirming",
        attempt: state.attempt,
        conn: state.conn,
        directory: state.directory,
        project: event.project,
        wasUsed: event.wasUsed,
      },
      effects: [
        {
          type: "dialog.open",
          attempt: state.attempt,
          conn: state.conn,
          project: event.project,
          directory: state.directory,
          wasUsed: event.wasUsed,
        },
      ],
    }
  }

  if (event.type !== "dialog.closed") return { state, effects: NO_EFFECTS }
  if (event.deleted || state.wasUsed)
    return { state: { status: "idle", attempt: state.attempt }, effects: NO_EFFECTS }
  return {
    state: { status: "idle", attempt: state.attempt },
    effects: [{ type: "project.hide", attempt: state.attempt, conn: state.conn, project: state.project }],
  }
}
