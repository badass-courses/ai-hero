import type { DrovrShadowEvent } from './drovr-shadow-emitter'

export type DirectoryBirthLifecycle = 'provisional' | 'unsubscribed' | 'bounced'
export type DirectoryBirthStandingReader = (
	births: readonly DrovrShadowEvent[],
) => Promise<ReadonlyMap<string, DirectoryBirthLifecycle>>

export const isDirectoryBirth = (event: DrovrShadowEvent): boolean =>
	event.journeyId === 'contact-directory' &&
	event.type === 'contact.created'

/** Every delivery road checks standing before a directory actor is born. */
export async function prepareDirectoryBirths(
	events: readonly DrovrShadowEvent[],
	read: DirectoryBirthStandingReader = async (births) => {
		const { readDirectoryBirthStanding } =
			await import('./drovr-directory-birth-standing-live')
		return readDirectoryBirthStanding(births)
	},
): Promise<DrovrShadowEvent[]> {
	const births = events.filter(isDirectoryBirth)
	if (births.length === 0) return [...events]
	// Failed or missing evidence must retry, never silently admit a provisional birth.
	const standing = await read(births)
	return events.map((event) => {
		if (!births.includes(event)) return event
		const lifecycle = standing.get(event.contactId)
		if (!lifecycle) throw new Error('Directory birth standing missing')
		const payload = event.payload as Record<string, unknown> | undefined
		// A replay of already-stopped bytes cannot become an active birth.
		if (
			lifecycle === 'provisional' ||
			payload?.lifecycle === 'unsubscribed' ||
			payload?.lifecycle === 'bounced'
		)
			return event
		return { ...event, payload: { ...payload, lifecycle } } as DrovrShadowEvent
	})
}
