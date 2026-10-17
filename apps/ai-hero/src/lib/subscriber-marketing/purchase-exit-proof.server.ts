import 'server-only'

import { db } from '@/db'
import { purchases, users } from '@/db/schema'
import { PURCHASE_EXIT_PROOF } from '@/flags/flag-definitions'
import { getFlagKey } from '@/flags/flag-key'
import { decodeFlagValue } from '@/flags/flags-adapter'
import { AI_CODING_CRASH_COURSE_PRODUCT_ID } from '@/lib/crash-course-purchaser-tag'
import { redis } from '@/server/redis-client'
import { and, eq } from 'drizzle-orm'

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

/** Statuses of the Crash Course purchases recorded for this email's account. */
export async function findCrashCoursePurchaseStatuses(
	email: string,
): Promise<string[]> {
	const rows = await db
		.select({ status: purchases.status })
		.from(purchases)
		.innerJoin(users, eq(purchases.userId, users.id))
		.where(
			and(
				eq(users.email, email),
				eq(purchases.productId, AI_CODING_CRASH_COURSE_PRODUCT_ID),
			),
		)
	return rows.map((row) => String(row.status))
}
