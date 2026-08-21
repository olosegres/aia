import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260820205457_session_cache_root",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`cache_root_id\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
