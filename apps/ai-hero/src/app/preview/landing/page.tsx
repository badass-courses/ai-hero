import { promises as fs } from 'node:fs'
import path from 'node:path'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'

import { LandingBody } from '../../_components/landing-body'

/**
 * Local landing-page preview: renders `content/landing.md` from disk instead
 * of the CMS row the real homepage loads. Same component map, same chrome, so
 * what you see here is what `landing-page-v2` will look like once the file is
 * pushed to the CMS.
 *
 * Dev-only. In production this 404s — the file on disk is a mirror kept for
 * diffing, not a second source of truth, and shipping a route that could
 * silently diverge from the CMS body is worse than having no route.
 */
export const dynamic = 'force-dynamic'

export const metadata = { robots: { index: false, follow: false } }

export default async function LandingPreviewPage() {
	if (process.env.NODE_ENV === 'production') notFound()

	const source = await fs.readFile(
		path.join(process.cwd(), 'content', 'landing.md'),
		'utf-8',
	)

	return (
		<LayoutClient withContainer>
			<LandingBody source={source} />
		</LayoutClient>
	)
}
