import Link from 'next/link'

import { C5SaleSwitch } from './c5-sale-switch'
import { TYPE } from './landing/type'
import { C5_TITLE } from './navigation/promo-config'

// Bound this campaign to the archived landing pages, never the current cohort.
export const C5_PAST_COHORT_SLUGS = [
	'ai-coding-for-real-engineers-m0k0w',
	'claude-code-for-real-engineers-2026-04',
	'build-your-own-ai-personal-assistant-in-typescript',
	'build-deepsearch-in-typescript',
] as const

/** Shown to visitors and alumni alike, without changing the old cohort. */
export function C5PastCohortCallout({ slug }: { slug: string }) {
	if (!C5_PAST_COHORT_SLUGS.some((pastSlug) => pastSlug === slug)) return null

	return (
		<C5SaleSwitch>
			<aside className="not-prose border-border bg-muted border-b">
				<p className={`${TYPE.meta} px-[18px] py-6 sm:px-11`}>
					Enrollment for this cohort has closed. The new cohort,{' '}
					<Link
						href="/s/c5-site-cta"
						className="text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
					>
						{C5_TITLE}
					</Link>
					, is open now.
				</p>
			</aside>
		</C5SaleSwitch>
	)
}
