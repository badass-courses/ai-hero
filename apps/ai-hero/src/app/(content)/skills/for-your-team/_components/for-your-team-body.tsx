import * as React from 'react'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { Prose } from '@/components/landing/prose'
import { compileMDX } from '@/utils/compile-mdx'

import { CrashCourseArt, CrashCourseCta } from './crash-course-cta'
import {
	LearnItem,
	LearnList,
	TeamSplit,
	SlidesCard,
	TeamClose,
	TeamCloseBody,
	TeamHero,
} from './for-your-team-blocks'

/**
 * The MDX component map for `/skills/for-your-team`, plus the page chrome.
 *
 * Same shape as `LandingBody`: the body is a CMS `page` row, this decides what
 * the tags in it mean. Kept in its own file rather than inline in the route so
 * that a preview surface rendering the on-disk mirror can share the exact map —
 * a component registered for one and missing on the other is the failure this
 * split prevents.
 */
export async function ForYourTeamBody({
	source,
	pageId,
}: {
	source: string
	pageId: string
}) {
	const components = {
		// The CMS row's id reaches the hero from the route, not from the body: the
		// empty-video placeholder names the row that fills it, and a page that
		// could name the wrong row in its own body would be worse than naming
		// none.
		TeamHero: (props: React.ComponentProps<typeof TeamHero>) => (
			<TeamHero {...props} cmsPageId={pageId} />
		),
		LearnList,
		LearnItem,
		TeamSplit,
		// Same treatment as the hero's empty video slot: with no `href` the card
		// says which row to add it to, rather than rendering a dead control.
		SlidesCard: (props: React.ComponentProps<typeof SlidesCard>) => (
			<SlidesCard {...props} cmsPageId={pageId} />
		),
		// The cover art goes above the heading, so it is injected here rather
		// than authored in the body: the page knows which product it promotes.
		TeamClose: (props: React.ComponentProps<typeof TeamClose>) => (
			<TeamClose {...props} media={<CrashCourseArt />} />
		),
		TeamCloseBody,
		CompanyLogoGrid,
		Prose,
		// The ask. Waitlist before the crash course opens, a door to it after —
		// decided by the workshop's own published state, not by this body. The
		// copy for both halves is editable here; which half renders is not.
		TeamCta: CrashCourseCta,
	}

	const compiled = await compileMDX(source, components as any)

	return (
		<main className="bg-background text-foreground">
			{/* Separators are the container's job, not each section's — the same
			    idiom `LandingBody` uses. Every child after the first draws its own
			    top rule and pulls up 1px, so sections can be reordered, added or
			    removed in the CMS without a doubled rule or a missing one. */}
			<article className="[&>*+*]:border-border [&>*+*]:-mt-px [&>*+*]:border-t">
				{compiled.content}
			</article>
		</main>
	)
}
