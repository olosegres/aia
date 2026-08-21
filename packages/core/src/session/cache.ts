export * as SessionCache from "./cache"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

export const findRootID = Effect.fn("SessionCache.findRootID")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
) {
  const row = yield* db
    .select({ id: SessionTable.id, cacheRootID: SessionTable.cache_root_id })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.orDie)
  return row ? (row.cacheRootID ?? row.id) : undefined
})

export function promptKey(rootID: string) {
  return /^ses_[0-9a-f]{64}$/.test(rootID) ? rootID.slice(4) : rootID
}
