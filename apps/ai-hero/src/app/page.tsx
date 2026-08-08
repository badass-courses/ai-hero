import type { Metadata, ResolvingMetadata } from 'next'
import LayoutClient from '@/components/layout-client'
import { courseBuilderAdapter } from '@/db'
import { getPage } from '@/lib/pages-query'

import { LandingBody } from './_components/landing-body'

import { getCouponForCode } from '@coursebuilder/commerce/props-for-commerce'

type Props = {
	searchParams: Promise<{ [key: string]: string | undefined }>
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const searchParams = await props.searchParams
	let ogImageUrl =
		'https://res.cloudinary.com/total-typescript/image/upload/v1777557385/og-image-root_2x.jpg'
	const codeParam = searchParams?.code
	const couponParam = searchParams?.coupon
	const couponCodeOrId = codeParam || couponParam
	if (couponCodeOrId) {
		const coupon = await getCouponForCode(
			couponCodeOrId,
			[],
			courseBuilderAdapter,
		)
		const validCoupon = Boolean(coupon && coupon.isValid)
		if (validCoupon)
			ogImageUrl =
				'https://res.cloudinary.com/total-typescript/image/upload/v1730364326/aihero-golden-ticket_2x_qghsfq.png'
	}

	return {
		title: {
			template: '%s | AI Hero',
			default: `Become a Real AI Hero`,
		},
		openGraph: {
			images: ogImageUrl ? [{ url: ogImageUrl }] : [],
		},
	}
}

export default async function DraftLandingPage(props: Props) {
	const searchParams = await props.searchParams
	// W4 revision lives in its own CMS row. The homepage body is loaded from the
	// SHARED PROD DB at runtime, so editing `landing-page` would change the live
	// site the moment it saved, before this branch deploys. `landing-page-v2` is
	// published + unlisted; `landing-page` stays untouched as the rollback.
	//
	// `content/landing.md` mirrors this body for diffing; `/preview/landing`
	// renders that file directly in dev.
	//
	// Falling back to `landing-page` makes that rollback REAL rather than
	// theoretical. `getPage` returns null when the row is absent, renamed, or
	// fails schema parsing, and the v2 row is created out-of-band from this
	// deploy — so without the fallback, an empty body reached `LandingBody` and
	// the site root served a completely blank page with HTTP 200: no error, no
	// signal, nothing to alert on. The old row is the last thing that was known
	// to render.
	const page =
		(await getPage('landing-page-v2')) ?? (await getPage('landing-page'))
	const previewLiveStreams =
		process.env.NODE_ENV !== 'production' && searchParams?.livePreview === '1'

	return (
		<LayoutClient withContainer>
			<LandingBody
				source={page?.fields.body ?? ''}
				previewLiveStreams={previewLiveStreams}
			/>
		</LayoutClient>
	)
}
