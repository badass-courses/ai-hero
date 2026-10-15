import { contactProfileVersion } from '@/db/contact-sync-schema'
import { asc, and, count, eq, isNull, lte, or } from 'drizzle-orm'
import {
	RESTATEMENT_CONTACTS_PER_TICK,
	restatementPlan,
} from './contact-sync-deltas'

/** The real oldest-first query, shared by the scheduler and MySQL contract.
 * Only already-acknowledged versions are eligible for profile-only renewal.
 */
export async function dueProfileConfirmations(
	database: unknown,
	now: number,
	capacityAlert: (fields: {
		population: number
		contactsPerTick: number
		monthlyCapacity: number
	}) => Promise<unknown>,
) {
	const db = database as Pick<typeof import('@/db').db, 'select'>
	const [population] = await db
		.select({ total: count() })
		.from(contactProfileVersion)
	const total = Number(population?.total ?? 0)
	let plan: ReturnType<typeof restatementPlan>
	try {
		plan = restatementPlan(total, now)
	} catch (error) {
		await capacityAlert({
			population: total,
			contactsPerTick: RESTATEMENT_CONTACTS_PER_TICK,
			monthlyCapacity: RESTATEMENT_CONTACTS_PER_TICK * 30 * 24 * 4,
		})
		throw error
	}
	return db
		.select({ contactId: contactProfileVersion.contactId })
		.from(contactProfileVersion)
		.where(
			and(
				eq(
					contactProfileVersion.acknowledgedVersion,
					contactProfileVersion.profileVersion,
				),
				or(
					isNull(contactProfileVersion.acknowledgedAt),
					lte(
						contactProfileVersion.acknowledgedAt,
						new Date(plan.before).toISOString().slice(0, 23).replace('T', ' '),
					),
				),
			),
		)
		.orderBy(
			asc(contactProfileVersion.acknowledgedAt),
			asc(contactProfileVersion.contactId),
		)
		.limit(plan.contacts)
}
