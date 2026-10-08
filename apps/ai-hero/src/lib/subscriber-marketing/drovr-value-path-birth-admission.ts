import { activeContactStopsByKey, stopSignalOfEvent } from './contact-stop-rule'
import {
	prepareDirectoryBirths,
	type DirectoryBirthStandingReader,
} from './drovr-directory-birth-standing'
import { isValuePathBirth } from './drovr-bulk-freeze'
import type { DrovrShadowEvent } from './drovr-shadow-emitter'

export type RecordedBirthOptOut = {
	contactId: string
	eventType: string
	occurredAt: string | Date
}

export function unsubscribedBirthContactIds(
	rows: readonly RecordedBirthOptOut[],
): Set<string> {
	const stops = activeContactStopsByKey(
		rows.map((row) => ({
			key: row.contactId,
			signal: stopSignalOfEvent(row),
		})),
	)
	return new Set(
		[...stops].filter(([, stop]) => stop.unsubscribed).map(([id]) => id),
	)
}

export async function admitValuePathBirths(args: {
	events: readonly DrovrShadowEvent[]
	read: (contactIds: readonly string[]) => Promise<readonly string[]>
	info: (event: string, fields: Record<string, unknown>) => unknown
	readDirectoryStanding?: DirectoryBirthStandingReader
}): Promise<{ events: DrovrShadowEvent[]; skipped: number }> {
	const prepared = await prepareDirectoryBirths(
		args.events,
		args.readDirectoryStanding,
	)
	const births = prepared.filter(isValuePathBirth)
	if (births.length === 0) return { events: prepared, skipped: 0 }
	// A failed read throws, never admits an uncertain birth.
	const stopped = new Set(
		await args.read([...new Set(births.map((event) => event.contactId))]),
	)
	const events = prepared.filter(
		(event) => !isValuePathBirth(event) || !stopped.has(event.contactId),
	)
	const skipped = args.events.length - events.length
	if (skipped > 0) {
		try {
			await args.info('drovr.value_path.births_skipped_unsubscribed', {
				count: skipped,
				contactIds: [
					...new Set(
						births
							.filter((event) => stopped.has(event.contactId))
							.map((event) => event.contactId),
					),
				],
			})
		} catch {
			// A broken logger cannot turn a skip into a birth.
		}
	}
	return { events, skipped }
}
