import type { Metadata } from 'next'
import { courseBuilderAdapter } from '@/db'

import { getCouponForCode } from '@coursebuilder/core/lib/pricing/props-for-commerce'

const DEFAULT_OG_IMAGE =
	'https://res.cloudinary.com/total-typescript/image/upload/v1777557385/og-image-root_2x.jpg'
const GOLDEN_TICKET_OG_IMAGE =
	'https://res.cloudinary.com/total-typescript/image/upload/v1730364326/aihero-golden-ticket_2x_qghsfq.png'

export type HomeCouponPageProps = {
	searchParams: Promise<Record<string, string | undefined>>
}

export async function getHomeCouponMetadata(
	props: HomeCouponPageProps,
): Promise<Metadata> {
	const searchParams = await props.searchParams
	let ogImageUrl = DEFAULT_OG_IMAGE
	const couponCodeOrId = searchParams.code || searchParams.coupon

	if (couponCodeOrId) {
		const coupon = await getCouponForCode(
			couponCodeOrId,
			[],
			courseBuilderAdapter,
		)

		if (coupon && coupon.isValid) ogImageUrl = GOLDEN_TICKET_OG_IMAGE
	}

	return {
		alternates: { canonical: '/' },
		robots: { index: false },
		openGraph: {
			images: [{ url: ogImageUrl }],
		},
	}
}
