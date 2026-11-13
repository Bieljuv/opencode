import { Effect } from "effect"
import type { DatabaseMigration } from "../migration.js"

const migration: DatabaseMigration.Migration = {
  id: "20261113151454_trash",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`trash\` (
          \`id\` text PRIMARY KEY,
          \`name\` text,
          \`directory\` text NOT NULL,
          \`trash_path\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`time_trashed\` integer NOT NULL
        );
      `)
    })
  },
}

export default migration
