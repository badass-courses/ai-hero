import { eq } from 'drizzle-orm'

import { courseBuilderAdapter, createDatabaseHandle, db } from '@/db'
import { contact, coupon, users } from '@/db/schema'
import { env } from '@/env.mjs'
import {
	emailEquivalenceKey,
	normalizeEmail,
} from '@/lib/subscriber-marketing/contact-email-equivalence'
import { parseDrovrEvergreenConfig } from '@/lib/subscriber-marketing/drovr-evergreen'
import {
	createDrovrEvergreenClaimApplication,
	drovrClaimVerifiedOwnerReader,
} from '@/lib/subscriber-marketing/drovr-evergreen-claim'
import { createCouponAuthority } from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority'
import {
	couponCommerceSchema,
	createMySqlCouponCommerceStore,
} from '@/lib/subscriber-marketing/evergreen-offer-journey/coupon-authority-mysql'
import { resolveEvergreenMerchantEvidence } from '@/lib/subscriber-marketing/evergreen-merchant-evidence'
import { log } from '@/server/logger'

import { createEvergreenClaimHttp } from './evergreen-claim-http'
import { pilotNotFound } from './evergreen-pilot-application'

export const DROVR_EVERGREEN_CLAIM_PRODUCT_PATH =
	'/workshops/ai-coding-crash-course'

/** Off unless the drovr evergreen rollout is on; then the same claim HTTP
 * contract the panel already speaks, over the drovr claim application. */
export function drovrEvergreenClaimEnabled(): boolean {
	return parseDrovrEvergreenConfig(process.env).enabled
}

function composeDrovrEvergreenClaim() {
	const getSessionAndUser =
		courseBuilderAdapter.getSessionAndUser?.bind(courseBuilderAdapter)
	if (!getSessionAndUser) throw new Error('session lookup unavailable')
	const now = () => new Date().toISOString()
	const application = createDrovrEvergreenClaimApplication({
		readers: {
			userById: async (id) =>
				(
					await db
						.select({
							id: users.id,
							email: users.email,
							emailVerified: users.emailVerified,
						})
						.from(users)
						.where(eq(users.id, id))
						.limit(1)
				)[0],
			// The indexed equivalence key of the normalized address, the same key
			// the bind path locks on, so case or whitespace differences between
			// the user's address and the stored contact still resolve. Exactly
			// one row or nothing: ambiguity is never a claim.
			contactByEmail: async (email) => {
				const rows = await db
					.select({ id: contact.id, email: contact.email })
					.from(contact)
					.where(
						eq(contact.emailKey, emailEquivalenceKey(normalizeEmail(email))),
					)
					.limit(2)
				return rows.length === 1 ? rows[0] : undefined
			},
			couponById: async (id) =>
				(await db.select().from(coupon).where(eq(coupon.id, id)).limit(1))[0],
		},
		// Merchant evidence is read here, on the claim only, so the status GET
		// never enters the merchant coupon creation path.
		resolveAuthority: async () =>
			createCouponAuthority({
				store: createMySqlCouponCommerceStore(
					createDatabaseHandle(couponCommerceSchema),
				),
				merchantCouponEvidence: await resolveEvergreenMerchantEvidence(),
				readVerifiedOwner: drovrClaimVerifiedOwnerReader(now),
				now,
			}),
		now,
		onBindFailure: (reason) => {
			void log.warn('drovr.evergreen.claim_bind_failed', { reason })
		},
	})
	return createEvergreenClaimHttp({
		enabled: true,
		origin: env.NEXT_PUBLIC_URL,
		productPath: DROVR_EVERGREEN_CLAIM_PRODUCT_PATH,
		secret: env.NEXTAUTH_SECRET ?? '',
		getSessionAndUser,
		application,
	})
}

export async function drovrEvergreenClaimHandler(request: Request) {
	if (!drovrEvergreenClaimEnabled()) return pilotNotFound()
	try {
		const handler = composeDrovrEvergreenClaim()
		return await handler(request)
	} catch (error) {
		await log.error('drovr.evergreen.claim_unavailable', {
			error: error instanceof Error ? error.message : String(error),
		})
		return pilotNotFound()
	}
}
