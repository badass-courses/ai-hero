import 'server-only'

import { db } from '@/db'
import { contact, providerIdentity } from '@/db/schema'
import { and, eq } from 'drizzle-orm'

/**
 * Who a Kit subscriber id belongs to, answered from AI Hero's own contact
 * directory instead of Kit.
 *
 * Kit ids stay the public alias: every broadcast link, signed progress link and
 * year-long `ck_subscriber` cookie carries one, and the directory keeps the
 * same id as a `ProviderIdentity` row (provider `kit`). Resolving through it
 * keeps those links working with Kit out of the request path.
 *
 * Identity only. Kit's list `state` and custom `fields` are not here: the
 * directory has no current answer for either, so the record leaves them unset
 * and callers keep whatever their own cookie snapshot says. Unset state reads
 * as "not on the list", which shows an ask — the safe direction gating already
 * takes for every unknown.
 */
export type KitSubscriberIdentity = {
	id: number
	email_address: string
	first_name?: string
}

type DirectoryReader = {
	query: {
		providerIdentity: {
			findFirst: (args: unknown) => Promise<{ contactId: string } | undefined>
		}
		contact: {
			findFirst: (
				args: unknown,
			) => Promise<{ email: string | null; name: string | null } | undefined>
		}
	}
}

/**
 * A Kit id as cookies and links carry it: digits, sometimes JSON-quoted
 * (`setSubscriberCookie` stores `JSON.stringify(id)`). Anything else is not an
 * id, and is never sent to the database.
 */
export function parseKitSubscriberId(value: unknown): string | null {
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) && value > 0 ? String(value) : null
	}
	if (typeof value !== 'string') return null
	const id = value.trim().replace(/^"(.*)"$/, '$1')
	if (!/^\d{1,20}$/.test(id)) return null
	const numeric = Number(id)
	return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : null
}

/**
 * The directory's identity for one Kit subscriber id, or null when the id is
 * malformed or unknown. A database failure throws; callers decide, and every
 * current caller treats it the way it treated a failed Kit read.
 */
export async function readKitSubscriberIdentity(
	kitSubscriberId: unknown,
	reader: DirectoryReader = db as unknown as DirectoryReader,
): Promise<KitSubscriberIdentity | null> {
	const found = await readKitSubscriberContact(kitSubscriberId, reader)
	if (!found) return null
	return {
		id: found.id,
		email_address: found.email,
		...(found.firstName ? { first_name: found.firstName } : {}),
	}
}

/**
 * The directory contact behind one Kit subscriber id: the same lookup as
 * `readKitSubscriberIdentity`, plus the contact id for callers that read the
 * contact's own evidence. Never spread into a cookie.
 */
export async function readKitSubscriberContact(
	kitSubscriberId: unknown,
	reader: DirectoryReader = db as unknown as DirectoryReader,
): Promise<{
	id: number
	contactId: string
	email: string
	firstName?: string
} | null> {
	const id = parseKitSubscriberId(kitSubscriberId)
	if (!id) return null

	const identity = await reader.query.providerIdentity.findFirst({
		where: and(
			eq(providerIdentity.provider, 'kit'),
			eq(providerIdentity.externalId, id),
		),
		columns: { contactId: true },
	})
	if (!identity) return null

	const row = await reader.query.contact.findFirst({
		where: eq(contact.id, identity.contactId),
		columns: { email: true, name: true },
	})
	const email = row?.email?.trim()
	if (!email) return null

	const firstName = row?.name?.trim()
	return {
		id: Number(id),
		contactId: identity.contactId,
		email,
		...(firstName ? { firstName } : {}),
	}
}
