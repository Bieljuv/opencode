import { Project } from "@opencode/core/project"
import { Session } from "@opencode/core/session"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/http-api"
import os from "os"
import { Api } from "../api"
import { InvalidRequestError, ProjectNotFoundError } from "@opencode/protocol/errors"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  Effect.gen(function* () {
    const project = yield* Project.Service
    const session = yield* Session.Service
    const fs = yield* FSUtil.Service

    const missingProject = (projectID: Project.ID) =>
      new ProjectNotFoundError({
        projectID,
        message: `Project not found: ${projectID}`,
      })

    return handlers
      .handle("project.list", (ctx) => project.list(ctx.query))
      .handle("project.update", (ctx) =>
        project.update({ ...ctx.payload, projectID: ctx.params.projectID }).pipe(
          Effect.mapError(() => missingProject(ctx.params.projectID)),
        ),
      )
      .handle(
        "project.delete",
        Effect.fn(function* (ctx) {
          const projectID = ctx.params.projectID
          const info = (yield* project.list()).find((item) => item.id === projectID)
          if (!info) return yield* missingProject(projectID)
          // Refuse before removing any session: a refused delete must leave the project untouched.
          const canonical = yield* fs.resolve(info.canonical)
          const home = yield* fs.resolve(os.homedir())
          const refusal = Project.deleteRefusal(projectID, canonical, home)
          if (refusal)
            return yield* new InvalidRequestError({ message: `Project cannot be deleted: ${refusal.reason}` })
          // Stop the project's sessions first, paging through them: a running agent must not outlive its directory.
          const removeSessions = (cursor: Session.ListCursor | undefined): Effect.Effect<void, InvalidRequestError> =>
            Effect.gen(function* () {
              const page = yield* session.list({ project: projectID, cursor }).pipe(
                Effect.catchTag(
                  "Session.InvalidListCursorError",
                  (error) => new InvalidRequestError({ message: error.message }),
                ),
              )
              yield* Effect.forEach(page.data, (item) =>
                session.remove(item.id).pipe(Effect.catchTag("Session.NotFoundError", () => Effect.void)),
              )
              if (page.cursor.next) yield* removeSessions(page.cursor.next)
            })
          yield* removeSessions(undefined)
          yield* project.delete(projectID).pipe(
            Effect.catchTag("Project.NotFoundError", () => missingProject(projectID)),
            Effect.catchTag(
              "Project.DeleteRefusedError",
              (error) => new InvalidRequestError({ message: `Project cannot be deleted: ${error.reason}` }),
            ),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
