import { getSubscriberFromCookie } from '@/lib/convertkit'
import { hasEntitlementForResource } from '@/lib/entitlements-query'
import { getCtaGatingPayload } from '@/lib/subscriber-gate'
import { createTRPCRouter, publicProcedure } from '@/trpc/api/trpc'
import { getCurrentAbilityRules } from '@/utils/get-current-ability-rules'
import { z } from 'zod'

export const abilityRouter = createTRPCRouter({
	getCurrentAbilityRules: publicProcedure
		.input(
			z
				.object({
					lessonId: z.string().optional(),
					moduleId: z.string().optional(),
				})
				.optional(),
		)
		.query(async ({ ctx, input }) => {
			const abilityRules = await getCurrentAbilityRules({
				lessonId: input?.lessonId,
				moduleId: input?.moduleId,
			})

			return abilityRules
		}),
	getCurrentSubscriberFromCookie: publicProcedure.query(async ({ ctx }) => {
		return getSubscriberFromCookie()
	}),
	/**
	 * Whether this viewer has already answered an ask, and nothing more.
	 *
	 * Separate from `getCurrentSubscriberFromCookie` because the two want
	 * different things. That one guarantees a complete, current record and will
	 * call Kit to get one — which the survey needs, since it posts answers
	 * against the address. This one only has to answer "have you already done
	 * this?", which the cookie already knows, so it reads the cookie and stops.
	 *
	 * It returns `getCtaGatingPayload` rather than the subscriber itself. This is
	 * a `publicProcedure`: anyone can call it, and `ck_subscriber_id` is a plain
	 * cookie the middleware fills from a query parameter on broadcast links.
	 * Handing the full record to that caller would let anyone name a subscriber
	 * id and read back the matching email address. The payload carries `state`
	 * and the interest flags, and the id-cookie path does not reach Kit at all.
	 *
	 * (`getCurrentSubscriberFromCookie` above still has that shape. It predates
	 * this and the survey depends on the full record, so it is left alone here
	 * rather than changed as a side effect of adding CTA gating.)
	 */
	getSubscriberForCtaGating: publicProcedure.query(async () => {
		return getCtaGatingPayload()
	}),
	/**
	 * Does the signed-in viewer already own this resource?
	 *
	 * Exists so the nav bar can stop selling a cohort to the people who bought
	 * it. Ownership cannot be resolved where the rest of the offer is: the bar
	 * lives in the root layout, and `getNextOffer` is deliberately impersonal
	 * so that layout never reads a cookie — one `cookies()` call up there would
	 * make every route on the site dynamic, including the hundred that are
	 * prerendered today.
	 *
	 * So it is answered here, on demand, and the caller is expected to ask only
	 * when the answer can change what it draws: signed in, with an offer on
	 * screen. A signed-out visitor owns nothing and must not cost a query.
	 */
	ownsResource: publicProcedure
		.input(z.object({ resourceId: z.string() }))
		.query(async ({ ctx, input }) => {
			const userId = ctx.session?.user?.id
			if (!userId) return { owned: false }
			return {
				owned: await hasEntitlementForResource(userId, input.resourceId),
			}
		}),
})
