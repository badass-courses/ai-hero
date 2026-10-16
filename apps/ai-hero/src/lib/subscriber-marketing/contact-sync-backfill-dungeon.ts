import { NonRetriableError } from 'inngest'

export const BACKFILL_DUNGEON_FLAG = 'AIH_DROVR_BACKFILL_DUNGEON_OVERRIDE'
export const BACKFILL_DUNGEON_CONFIRMATION =
	'I ACCEPT JOELS 2026-10-15 RULING: FULL RE-SYNCS BELONG IN THE DUNGEON'

/** Not a repaired or recommended bulk path. The default is refusal, before
 * any SDK step, scan, snapshot, capture, publish or version acknowledgement. */
export function requireBackfillDungeonOverride(
	env: Readonly<Record<string, string | undefined>>,
): void {
	if (env[BACKFILL_DUNGEON_FLAG] === BACKFILL_DUNGEON_CONFIRMATION) return
	throw new NonRetriableError(
		`BackfillDungeon: you requested a full contact re-sync, and it failed because Joel ruled on 2026-10-15 that drovr stays current contact by contact and redundant or full re-syncs belong in the dungeon or get deleted. Accepted: only an explicit operator override ${BACKFILL_DUNGEON_FLAG}=${JSON.stringify(BACKFILL_DUNGEON_CONFIRMATION)}. Fix: use the contact-by-contact delta path; do not enable this legacy backfill without operator approval. Debug: this refusal performs no scans, snapshots, captures, publishes or acknowledgements; the backfill is dungeoned, not fixed.`,
	)
}
