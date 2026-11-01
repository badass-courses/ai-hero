import { DrovrListStateReply, type DrovrListState } from './drovr-list-state'
import { DROVR_SKILLS_COURSE_JOURNEY_ID } from './drovr-shadow-emitter'

export type OwnedSkillsAdmission =
	| { status: 'allow'; list: DrovrListState }
	| { status: 'doi'; list: DrovrListState }
	| { status: 'unavailable' }

/** The signed-in click is consent. A failed stop read is not consent evidence. */
export function ownedSkillsAdmission(
	list: DrovrListState | null,
): OwnedSkillsAdmission {
	if (!list) return { status: 'unavailable' }
	if (
		list.state === 'stopped' ||
		list.stops.some(
			(stop) =>
				stop.scope === 'all' ||
				stop.scope === `course:${DROVR_SKILLS_COURSE_JOURNEY_ID}`,
		)
	) {
		return { status: 'doi', list }
	}
	if (
		list.state === 'confirmed' ||
		list.state === 'unconfirmed' ||
		(list.state === 'unknown' &&
			(list.unknownReason === 'no-consent-evidence' ||
				list.unknownReason === 'no-contact'))
	) {
		return { status: 'allow', list }
	}
	return { status: 'unavailable' }
}

/** Same existing REST contract; preserve no-contact versus unavailable. */
export async function readOwnedSkillsAdmission(
	contactId: string,
	config: { baseUrl: string; apiKey: string; fetch?: typeof fetch } | undefined,
): Promise<OwnedSkillsAdmission> {
	if (!config || !contactId.trim()) return { status: 'unavailable' }
	const controller = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			(async () => {
				const query = new URLSearchParams({ contactId })
				const response = await (config.fetch ?? fetch)(
					`${config.baseUrl.replace(/\/$/, '')}/contact-list-state?${query}`,
					{
						method: 'GET',
						headers: {
							authorization: `Bearer ${config.apiKey}`,
							accept: 'application/json',
						},
						signal: controller.signal,
						cache: 'no-store',
					},
				)
				if (!response.ok) return { status: 'unavailable' as const }
				const list = DrovrListStateReply.parse(await response.json())
				if (
					list.contactId !== contactId &&
					!(
						list.contactId === null &&
						list.state === 'unknown' &&
						list.unknownReason === 'no-contact'
					)
				) {
					return { status: 'unavailable' as const }
				}
				return ownedSkillsAdmission(list)
			})(),
			new Promise<OwnedSkillsAdmission>((resolve) => {
				timer = setTimeout(() => {
					controller.abort()
					resolve({ status: 'unavailable' })
				}, 1500)
			}),
		])
	} catch {
		return { status: 'unavailable' }
	} finally {
		clearTimeout(timer)
	}
}
