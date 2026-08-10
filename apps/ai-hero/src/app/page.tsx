import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import { getCachedPage } from '@/lib/pages-query'

import { LandingBody } from './_components/landing-body'

export const revalidate = 3600
export const dynamic = 'force-static'

export const metadata: Metadata = {
	title: {
		template: '%s | AI Hero',
		default: 'Become a Real AI Hero',
	},
	openGraph: {
		images: [
			{
				url: 'https://res.cloudinary.com/total-typescript/image/upload/v1777557385/og-image-root_2x.jpg',
			},
		],
	},
}

export default async function DraftLandingPage() {
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
		(await getCachedPage('landing-page-v2')) ??
		(await getCachedPage('landing-page'))

	return (
		<LayoutClient withContainer>
			<LandingBody source={page?.fields.body ?? ''} />
		</LayoutClient>
	)
}
