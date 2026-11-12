import { db } from '@/db'
import { deviceVerifications } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import {
	DEVICE_ADMIN_SCOPE,
	deviceGrantFromCode,
	deviceOwnerAbility,
	matchesDeviceConsent,
} from '@/server/device-token-grant'
import { isAfter } from 'date-fns'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'

import { createTRPCRouter, publicProcedure } from '../trpc'

export const deviceVerificationRouter = createTRPCRouter({
	verify: publicProcedure
		.input(
			z.object({
				userCode: z.string(),
				consent: z.string().max(8192),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { session } = await getServerAuthSession()

			await log.debug('device.verification.check', {
				operation: 'session',
				hasSession: !!session,
				userId: session?.user?.id,
				userCode: input.userCode,
			})

			if (session) {
				const deviceVerification = await db.query.deviceVerifications.findFirst(
					{
						where: eq(deviceVerifications.userCode, input.userCode),
					},
				)

				await log.debug('device.verification.check', {
					operation: 'lookup',
					userCode: input.userCode,
					userId: session?.user?.id,
					found: !!deviceVerification,
					verified: !!deviceVerification?.verifiedAt,
				})

				if (deviceVerification) {
					if (deviceVerification.verifiedAt) {
						return { status: 'already-verified' }
					}

					if (isAfter(new Date(), deviceVerification.expires)) {
						return { status: 'code-expired' }
					}

					if (!session.user) {
						return { status: 'login-required' }
					}

					const grant = deviceGrantFromCode(deviceVerification.deviceCode)
					const ownerAbility =
						grant?.scope === DEVICE_ADMIN_SCOPE
							? await deviceOwnerAbility(session.user.id)
							: null
					if (
						!grant ||
						!matchesDeviceConsent(
							input.consent,
							input.userCode,
							deviceVerification.deviceCode,
							session.user.id,
						) ||
						(grant.scope === DEVICE_ADMIN_SCOPE &&
							!ownerAbility?.can('manage', 'all'))
					) {
						return { status: 'scope-denied' }
					}

					const [updated] = await db
						.update(deviceVerifications)
						.set({
							verifiedAt: new Date(),
							verifiedByUserId: session.user.id,
						})
						.where(
							and(
								eq(
									deviceVerifications.deviceCode,
									deviceVerification.deviceCode,
								),
								isNull(deviceVerifications.verifiedAt),
							),
						)

					return {
						status:
							updated.affectedRows === 1
								? 'device-verified'
								: 'already-verified',
					}
				} else {
					return { status: 'no-verification-found' }
				}
			} else {
				return { status: 'login-required' }
			}
		}),
})
