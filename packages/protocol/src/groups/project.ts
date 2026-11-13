import { Project } from "@opencode/schema/project"
import { Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"
import { InvalidRequestError, ProjectNotFoundError } from "../errors.js"

const root = "/api/project"
const UpdatePayload = Schema.Struct(Struct.omit(Project.UpdateInput.fields, ["projectID"]))
const BooleanFromString = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(Schema.Boolean, {
    decode: SchemaGetter.transform((value) => value === "true"),
    encode: SchemaGetter.transform((value): "true" | "false" => (value ? "true" : "false")),
  }),
)

export const ProjectGroup = HttpApiGroup.make("server.project")
  .add(
    HttpApiEndpoint.get("project.list", root, {
      query: Schema.Struct({ archived: BooleanFromString.pipe(Schema.optional) }),
      success: Schema.Array(Project.Info),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "project.list",
        summary: "List projects",
        description: "List known projects. Archived projects are excluded unless archived=true.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("trash.list", `${root}/trash`, {
      success: Schema.Array(Project.Trashed),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "trash.list",
        summary: "List trashed projects",
        description: "List projects moved to the trash, most recently trashed first.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("trash.restore", `${root}/trash/:projectID/restore`, {
      params: { projectID: Project.ID },
      success: Project.Info,
      error: [InvalidRequestError, ProjectNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "trash.restore",
        summary: "Restore trashed project",
        description:
          "Move a trashed project back to its original directory and back into the project list. Its sessions do not come back: they were removed when the project was trashed.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("trash.empty", `${root}/trash`, {
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "trash.empty",
        summary: "Empty trash",
        description:
          "Permanently delete every trashed project folder from disk. This cannot be undone: the trash folders do not go through the operating system recycle bin.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.patch("project.update", `${root}/:projectID`, {
      params: { projectID: Project.ID },
      payload: UpdatePayload,
      success: Project.Info,
      error: ProjectNotFoundError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "project.update",
        summary: "Update project",
        description: "Update the project canonical directory, display metadata, and workspace commands.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.delete("project.delete", `${root}/:projectID`, {
      params: { projectID: Project.ID },
      // Returns the delete result instead of NoContent: when the trash copy is complete but the original
      // directory could not be removed (locked by another program), the result carries its path so the
      // app can warn the user to remove it by hand instead of failing the delete.
      success: Project.DeleteResult,
      error: [InvalidRequestError, ProjectNotFoundError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "project.delete",
        summary: "Delete project",
        description:
          "Move a project to the trash, closing its sessions first. The directory moves under the server's trash directory and can be restored; nothing is deleted from disk yet. When the directory is already gone there is nothing to recover, so the project is permanently deleted instead. When the trash copy is complete but the original directory could not be removed because it is in use, the delete still succeeds and the result carries the leftover directory.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "project",
      description: "Project routes.",
    }),
  )
