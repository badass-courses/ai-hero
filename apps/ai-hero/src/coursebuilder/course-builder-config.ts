import { emailListProvider } from '@/coursebuilder/email-list-provider'
import { emailProvider } from '@/coursebuilder/email-provider'
import { openaiProvider } from '@/coursebuilder/openai-provider'
import { stripeProvider } from '@/coursebuilder/stripe-provider'
import { transcriptProvider } from '@/coursebuilder/transcript-provider'
import { courseBuilderAdapter, rawCourseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import { inngest } from '@/inngest/inngest.server'
import { createUserWithPersonalOrg } from '@/lib/find-or-create-user'
import { withPrivateCompClaim } from '@/lib/coupon-batches/free-claim-request'
import {
	cloneAdapter,
	paidCouponPricingView,
} from '@/lib/paid-coupon-pricing-view'
import { authOptions, getServerAuthSession } from '@/server/auth'
import { NextRequest } from 'next/server'

import { userSchema } from '@coursebuilder/core/schemas'
import NextCourseBuilder, {
	type NextCourseBuilderConfig,
} from '@coursebuilder/next'

export const courseBuilderConfig = {
	baseUrl: env.COURSEBUILDER_URL,
	// Course Builder's handlers mint users (newsletter subscribe) through this
	// adapter, so its createUser provisions the personal organization.
	adapter: Object.assign(cloneAdapter(rawCourseBuilderAdapter), {
		createUser: createUserWithPersonalOrg,
	}),
	inngest,
	providers: [
		transcriptProvider,
		emailListProvider,
		openaiProvider,
		emailProvider,
		stripeProvider,
	],
	basePath: '/api/coursebuilder',
	getCurrentUser: async () => {
		const { session } = await getServerAuthSession()
		if (!session?.user) return null

		return userSchema.parse(session.user)
	},
	callbacks: {
		session: async (req) => {
			// TODO: there's nothing on the "session" but we can add whatever we want here
			return { ...req, example: 'just an example' }
		},
	},
	authConfig: authOptions,
} satisfies NextCourseBuilderConfig

export const {
	handlers: { POST: post, GET },
	coursebuilder,
} = NextCourseBuilder(courseBuilderConfig)

export type CourseBuilderRouteContext = {
	params: Promise<{ nextCourseBuilder: string[] }>
}
type CourseBuilderRouteHandler = (
	request: NextRequest,
	context?: CourseBuilderRouteContext,
) => Promise<Response>

export function POST(
	request: NextRequest,
	context?: CourseBuilderRouteContext,
) {
	// The dependency's declaration omits context. Forward the Next argument
	// regardless, including for unchanged Stripe requests.
	return withPrivateCompClaim(request, (safe) =>
		(post as CourseBuilderRouteHandler)(
			safe === request ? request : new NextRequest(safe),
			context,
		),
	)
}

// Separate HTTP pricing handlers; purchase/webhook writes retain the raw adapter.
export const { handlers: commercePricingHandlers } = NextCourseBuilder({
	...courseBuilderConfig,
	adapter: Object.assign(paidCouponPricingView(courseBuilderAdapter), {
		createUser: createUserWithPersonalOrg,
	}),
})
