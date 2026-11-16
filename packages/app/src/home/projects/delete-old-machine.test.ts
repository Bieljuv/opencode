import { expect, test } from "bun:test"
import type { ServerConnection } from "@/runtime/server/registry"
import type { LocalProject } from "@/shell/state/layout"
import {
  createProjectDeleteOldState,
  transitionProjectDeleteOld,
  type ProjectDeleteOldEvent,
  type ProjectDeleteOldTransition,
} from "./delete-old-machine"

const conn: ServerConnection.Any = { type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4096" } }

const project: LocalProject = { id: "prj_old", worktree: "D:\\Old Project" }

function replay(events: ProjectDeleteOldEvent[]) {
  return events.reduce<ProjectDeleteOldTransition[]>((steps, event) => {
    steps.push(transitionProjectDeleteOld(steps.at(-1)?.state ?? createProjectDeleteOldState(), event))

    return steps
  }, [])
}

const picked: ProjectDeleteOldEvent[] = [
  { type: "deleteOld.requested", conn },
  { type: "picker.closed", attempt: 1, directory: project.worktree },
]

test("requesting opens the picker, and a second request while picking starts nothing", () => {
  const [picking, again] = replay([
    { type: "deleteOld.requested", conn },
    { type: "deleteOld.requested", conn },
  ])

  expect(picking?.effects).toEqual([{ type: "picker.open", attempt: 1, conn }])
  expect(again?.state).toBe(picking!.state)
  expect(again?.effects).toEqual([])
})

test("a cancelled picker is quiet", () => {
  const [, cancelled] = replay([
    { type: "deleteOld.requested", conn },
    { type: "picker.closed", attempt: 1, directory: undefined },
  ])

  expect(cancelled?.state).toEqual({ status: "idle", attempt: 1 })
  expect(cancelled?.effects).toEqual([])
})

test("cancelling the delete of a folder the client had never used hides it again", () => {
  const [, , , cancelled] = replay([
    ...picked,
    { type: "add.succeeded", attempt: 1, project, wasUsed: false },
    { type: "dialog.closed", attempt: 1, deleted: false },
  ])

  expect(cancelled?.effects).toEqual([{ type: "project.hide", attempt: 1, conn, project }])
  expect(cancelled?.state).toEqual({ status: "idle", attempt: 1 })
})

test("a deleted folder needs no hide, and neither does a folder that was already listed", () => {
  const [, , , deleted] = replay([
    ...picked,
    { type: "add.succeeded", attempt: 1, project, wasUsed: false },
    { type: "dialog.closed", attempt: 1, deleted: true },
  ])

  const [, , , kept] = replay([
    ...picked,
    { type: "add.succeeded", attempt: 1, project, wasUsed: true },
    { type: "dialog.closed", attempt: 1, deleted: false },
  ])

  expect(deleted?.effects).toEqual([])
  expect(deleted?.state).toEqual({ status: "idle", attempt: 1 })
  expect(kept?.effects).toEqual([])
  expect(kept?.state).toEqual({ status: "idle", attempt: 1 })
})

test("a failed register returns to idle, and the next delete starts a new attempt", () => {
  const [, , failed, retried, stale] = replay([
    ...picked,
    { type: "add.failed", attempt: 1 },
    { type: "deleteOld.requested", conn },
    { type: "picker.closed", attempt: 1, directory: project.worktree },
  ])

  expect(failed?.state).toEqual({ status: "idle", attempt: 1 })
  expect(failed?.effects).toEqual([])
  expect(retried?.effects).toEqual([{ type: "picker.open", attempt: 2, conn }])
  expect(stale?.state).toBe(retried!.state)
  expect(stale?.effects).toEqual([])
})

test("disposed ignores everything after it", () => {
  const [, , disposed, late] = replay([
    ...picked,
    { type: "disposed" },
    { type: "dialog.closed", attempt: 1, deleted: false },
  ])

  expect(disposed?.state).toEqual({ status: "disposed", attempt: 2 })
  expect(disposed?.effects).toEqual([])
  expect(late?.state).toBe(disposed!.state)
  expect(late?.effects).toEqual([])
})
