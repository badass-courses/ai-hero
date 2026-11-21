import { db } from '@/db'
import { contentResource } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { subject } from '@casl/ability'
import { inArray } from 'drizzle-orm'

/**
 * Refuses unless the signed-in caller may update every content resource named.
 *
 * Server actions are callable by anyone who holds their action id, so each one
 * that writes content structure must check the session and the ability itself.
 * The check is per record, not per type: a contributor's rules are conditioned
 * on `createdById`, so `can('update', 'Content')` alone passes for any
 * contributor on anyone's content (security desk, sec-033/034, 2026-11-21).
 *
 * Fails closed: an id that doesn't resolve to a resource is refused.
 */
export async function requireContentUpdate(
	resourceIds: Array<string | null | undefined>,
) {
	const { session, ability } = await getServerAuthSession()
	if (!session?.user || ability.cannot('update', 'Content')) {
		throw new Error('Unauthorized')
	}
	const ids = [
		...new Set(resourceIds.filter((id): id is string => Boolean(id))),
	]
	if (ids.length === 0) return
	const rows = await db.query.contentResource.findMany({
		where: inArray(contentResource.id, ids),
		columns: { id: true, type: true, createdById: true },
	})
	if (rows.length !== ids.length) {
		throw new Error('Unauthorized')
	}
	for (const row of rows) {
		if (ability.cannot('update', subject('Content', row))) {
			throw new Error('Unauthorized')
		}
	}
}
