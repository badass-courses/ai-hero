import { providerIdentity } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

import {
	kitIdentityOf,
	type ContactKitIdentity,
} from './drovr-contact-profile-sync'

/** A contact's Kit subscriber id, or a conflict when it has two (kitIdentityOf). */
export async function findContactKitIdentity(
	// The same shape the capture repository takes; this only selects.
	database: unknown,
	contactId: string,
): Promise<ContactKitIdentity> {
	const db = database as {
		select: (fields: unknown) => {
			from: (table: unknown) => {
				where: (clause: unknown) => {
					limit: (n: number) => Promise<{ externalId: string }[]>
				}
			}
		}
	}
	const rows = await db
		.select({ externalId: providerIdentity.externalId })
		.from(providerIdentity)
		.where(
			and(
				eq(providerIdentity.contactId, contactId),
				eq(providerIdentity.provider, 'kit'),
			),
		)
		.limit(2)
	return kitIdentityOf(rows.map((row) => row.externalId))
}
