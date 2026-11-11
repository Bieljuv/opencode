export * as SessionRevert from "./revert.js"

import { and, asc, desc, eq, gt } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { Instance } from "../instance/service.js"
import { RelativePath } from "../schema.js"
import { Snapshot } from "../snapshot.js"
import { SessionEvent } from "./event.js"
import { MessageNotFoundError } from "./error.js"
import { SessionMessage } from "./message.js"
import { SessionSchema } from "./schema.js"
import { SessionHistory } from "./history.js"
import { SessionMessageTable } from "./sql.js"

interface BoundaryInput {
  readonly sessionID: SessionSchema.ID
  readonly messageID: SessionMessage.ID
}

export const stage = Effect.fn("SessionRevert.stage")(function* (input: {
  session: SessionSchema.Info
  messageID: SessionMessage.ID
  files?: boolean
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service
  const bus = yield* Bus.Service

  return yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const original = input.session.revert?.snapshot ?? (yield* snapshot.capture())
    const next = yield* plan(database.db, { sessionID: input.session.id, messageID: input.messageID })
    const restore = new Map<RelativePath, Snapshot.ID>()
    if (original) {
      for (const file of input.session.revert?.files ?? []) restore.set(RelativePath.make(file.file), original)
    }
    if (input.files !== false) for (const [file, tree] of next) restore.set(file, tree)
    if (restore.size) yield* snapshot.restore({ files: restore })
    const paths = input.files === false ? [] : Array.from(next.keys())
    const files = original
      ? yield* snapshot.diff({ from: original, to: (yield* snapshot.capture()) ?? original, paths })
      : []
    const revert = {
      messageID: input.messageID,
      snapshot: original,
      files,
    } satisfies SessionSchema.Info["revert"]
    yield* bus.publish(SessionEvent.RevertEvent.Staged, {
      sessionID: input.session.id,
      revert,
    })
    return revert
  }).pipe(instances.provide(input.session))
})

export const clear = Effect.fn("SessionRevert.clear")(function* (session: SessionSchema.Info) {
  const instances = yield* Instance.Service
  const bus = yield* Bus.Service
  yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    if (!session.revert) return
    const original = session.revert.snapshot
    if (original)
      yield* snapshot.restore({
        files: new Map((session.revert.files ?? []).map((file) => [RelativePath.make(file.file), original])),
      })
    yield* bus.publish(SessionEvent.RevertEvent.Cleared, {
      sessionID: session.id,
    })
  }).pipe(instances.provide(session))
})

export const commit = Effect.fn("SessionRevert.commit")(function* (bus: Bus.Interface, session: SessionSchema.Info) {
  if (!session.revert) return
  yield* bus.publish(SessionEvent.RevertEvent.Committed, {
    sessionID: session.id,
    to: session.revert.messageID,
  })
})

/**
 * ManosTech: undo one file edit (audit I-30). The file returns to its content
 * before the given assistant step; every other file that step touched stays
 * as it is. Returns `undefined` when there is nothing to undo — the step has
 * no snapshot, it never changed this file, or the file no longer holds the
 * step's result (already undone, or a later step changed it) — so restoring
 * an older tree never clobbers newer work.
 */
export const undoEdit = Effect.fn("SessionRevert.undoEdit")(function* (input: {
  session: SessionSchema.Info
  messageID: SessionMessage.ID
  file: string
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service

  return yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const row = yield* database.db
      .select()
      .from(SessionMessageTable)
      .where(
        and(eq(SessionMessageTable.session_id, input.session.id), eq(SessionMessageTable.id, input.messageID)),
      )
      .get()
      .pipe(Effect.orDie)
    if (!row) return yield* new MessageNotFoundError({ sessionID: input.session.id, messageID: input.messageID })
    const message = SessionHistory.decodeMessageRowSync(row)
    if (message.type !== "assistant" || !message.snapshot?.start) return undefined
    const target = RelativePath.make(input.file)
    if (!(yield* editStillStands(snapshot, message.snapshot.start, message.snapshot.end, target))) return undefined
    yield* snapshot.restore({ files: new Map([[target, message.snapshot.start]]) })
    return { messageID: input.messageID, file: input.file }
  }).pipe(instances.provide(input.session))
})

/**
 * ManosTech: undo the most recent single file edit (audit I-30). Walks the
 * assistant steps newest-first and restores the last file whose edit from
 * that step still stands; one invocation undoes one edit, so repeating it
 * walks back through the edits one file at a time. Returns `undefined` when
 * no step has an edit still standing.
 */
export const undoLastEdit = Effect.fn("SessionRevert.undoLastEdit")(function* (input: {
  session: SessionSchema.Info
}) {
  const instances = yield* Instance.Service
  const database = yield* Database.Service

  return yield* Effect.gen(function* () {
    const snapshot = yield* Snapshot.Service
    const rows = yield* database.db
      .select()
      .from(SessionMessageTable)
      .where(
        and(eq(SessionMessageTable.session_id, input.session.id), eq(SessionMessageTable.type, "assistant")),
      )
      .orderBy(desc(SessionMessageTable.seq))
      .limit(20)
      .all()
      .pipe(Effect.orDie)
    for (const row of rows) {
      const message = SessionHistory.decodeMessageRowSync(row)
      if (message.type !== "assistant" || !message.snapshot?.start) continue
      const start = message.snapshot.start
      const end = message.snapshot.end ?? (yield* snapshot.capture())
      if (!end) continue
      const changedByStep = yield* snapshot.files({ from: start, to: end })
      const current = yield* snapshot.capture()
      if (!current) continue
      const changedSince = yield* snapshot.files({ from: end, to: current })
      const target = changedByStep.filter((file) => !changedSince.includes(file)).at(-1)
      if (!target) continue
      yield* snapshot.restore({ files: new Map([[target, start]]) })
      return { messageID: message.id, file: target }
    }
    return undefined
  }).pipe(instances.provide(input.session))
})

/**
 * Whether the step's edit to `file` still stands: the step changed the file
 * (start → end) and nothing after the step changed it again (end → current).
 * A step without an end snapshot compares against a fresh capture, so its
 * edits count as standing.
 */
const editStillStands = Effect.fn("SessionRevert.editStillStands")(function* (
  snapshot: Snapshot.Interface,
  start: Snapshot.ID,
  end: Snapshot.ID | undefined,
  target: RelativePath,
) {
  const endTree = end ?? (yield* snapshot.capture())
  if (!endTree) return false
  const changedByStep = yield* snapshot.files({ from: start, to: endTree })
  if (!changedByStep.some((file) => file === target)) return false
  const current = yield* snapshot.capture()
  if (!current) return false
  const changedSince = yield* snapshot.files({ from: endTree, to: current })
  return !changedSince.some((file) => file === target)
})

const plan = Effect.fn("SessionRevert.plan")(function* (db: Database.Interface["db"], input: BoundaryInput) {
  const boundary = yield* db
    .select({ seq: SessionMessageTable.seq })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.messageID)))
    .get()
    .pipe(Effect.orDie)
  if (!boundary) return yield* new MessageNotFoundError(input)
  const rows = yield* db
    .select()
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, input.sessionID),
        eq(SessionMessageTable.type, "assistant"),
        gt(SessionMessageTable.seq, boundary.seq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const files = new Map<RelativePath, Snapshot.ID>()
  for (const row of rows) {
    const message = SessionHistory.decodeMessageRowSync(row)
    if (message.type !== "assistant" || !message.snapshot?.start) continue
    for (const file of message.snapshot.files ?? [])
      if (!files.has(file)) files.set(file, message.snapshot.start)
  }
  return files
})
