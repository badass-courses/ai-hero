import * as React from 'react'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { Prose } from '@/components/landing/prose'
import { courseBuilderAdapter } from '@/db'
import { compileMDX } from '@/utils/compile-mdx'

import { CrashCourseArt, CrashCourseCta } from './crash-course-cta'
import { TeamVideo } from './team-video'
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
	pageTitle,
}: {
	source: string
	pageId: string
	pageTitle: string
}) {
	/**
	 * This page's `<Video />`, overriding the global MDX one.
	 *
	 * The global mapping resolves a playback id and renders a bare player. This
	 * page needs the same player wrapped in something that can show the ask when
	 * it ends, so the override stops at this route rather than changing what
	 * `<Video />` means everywhere.
	 *
	 * The playback id is resolved HERE, on the server, exactly as the global
	 * mapping does it: only ids actually authored into this body are looked up,
	 * never arbitrary ones. The ask is passed down as `children` so the
	 * live-or-waitlist decision, and the database read behind it, never reach
	 * the browser.
	 */
	async function Video({
		resourceId,
		thumbnailTime,
		ctaHeading = 'Keep learning together',
		ctaBody = "If you want to learn more, faster, and together, you're going to love my upcoming AI Coding Crash Course, out in just a couple of weeks. Drop your info here and I'll email you the moment you can buy it at the best price, with special rates for teams.",
	}: {
		resourceId?: string
		thumbnailTime?: number
		/** The overlay's heading and its ask, both editable in the CMS body. */
		ctaHeading?: string
		ctaBody?: string
	}) {
		if (!resourceId) return null

		const videoResource = await courseBuilderAdapter
			.getVideoResource(resourceId)
			.catch(() => null)
		const playbackId = videoResource?.muxPlaybackId

		// Same contract as the empty slot: no playable video means the hero draws
		// its striped placeholder rather than an empty black box.
		if (!playbackId) return null

		return (
			<TeamVideo
				playbackId={playbackId}
				title={pageTitle}
				thumbnailTime={thumbnailTime}
				heading={ctaHeading}
			>
				{/* The overlay states the offer in full, because unlike the closing
				    band it has no paragraph above it doing that job. */}
				<CrashCourseCta confirmInPlace waitlistBody={ctaBody} />
			</TeamVideo>
		)
	}

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
		Video,
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
