import { db } from '@/db'
import { deviceVerifications } from '@/db/schema'
import { getServerAuthSession } from '@/server/auth'
import { log } from '@/server/logger'
import { isAfter } from 'date-fns'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

import { createTRPCRouter, publicProcedure } from '../trpc'

export const deviceVerificationRouter = createTRPCRouter({
	verify: publicProcedure
		.input(
			z.object({
				userCode: z.string(),
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

					await db
						.update(deviceVerifications)
						.set({
							verifiedAt: new Date(),
							verifiedByUserId: session.user.id,
						})
						.where(
							eq(deviceVerifications.deviceCode, deviceVerification.deviceCode),
						)

					return { status: 'device-verified' }
				} else {
					return { status: 'no-verification-found' }
				}
			} else {
				return { status: 'login-required' }
			}
		}),
})
