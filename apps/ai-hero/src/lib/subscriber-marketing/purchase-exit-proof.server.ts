import 'server-only'

import { db } from '@/db'
import { purchases, users } from '@/db/schema'
import { PURCHASE_EXIT_PROOF } from '@/flags/flag-definitions'
import { getFlagKey } from '@/flags/flag-key'
import { decodeFlagValue } from '@/flags/flags-adapter'
import { AI_CODING_CRASH_COURSE_PRODUCT_ID } from '@/lib/crash-course-purchaser-tag'
import { redis } from '@/server/redis-client'
import { and, eq, inArray } from 'drizzle-orm'

/** Fresh read on every pass. Unset, unreadable or slow counts as off. */
export async function purchaseExitProofEnabled(
	timeoutMs = 500,
): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			redis
				.get(getFlagKey(PURCHASE_EXIT_PROOF))
				.then((value) => decodeFlagValue(value)),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), timeoutMs)
			}),
		])
	} catch {
		return false
	} finally {
		clearTimeout(timer)
	}
}

/**
 * Statuses of Crash Course purchases per lower-cased account email, in one
 * query. The match follows the column collation; a miss only keeps a contact
 * held, never admits one.
 */
export async function findCrashCoursePurchaseStatuses(
	emails: string[],
): Promise<Map<string, string[]>> {
	const byEmail = new Map<string, string[]>()
	if (emails.length === 0) return byEmail
	const rows = await db
		.select({ email: users.email, status: purchases.status })
		.from(purchases)
		.innerJoin(users, eq(purchases.userId, users.id))
		.where(
			and(
				inArray(users.email, emails),
				eq(purchases.productId, AI_CODING_CRASH_COURSE_PRODUCT_ID),
			),
		)
	for (const row of rows) {
		if (!row.email) continue
		const key = row.email.toLowerCase()
		byEmail.set(key, [...(byEmail.get(key) ?? []), String(row.status)])
	}
	return byEmail
}
