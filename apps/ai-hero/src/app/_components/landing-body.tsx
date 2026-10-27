import * as React from 'react'
import { AboutMatt } from '@/components/landing/about-matt'
import {
	ActivityLadder,
	ActivityRung,
} from '@/components/landing/activity-ladder'
import { CompanyLogoGrid } from '@/components/landing/company-logo-grid'
import { DraftTestimonial } from '@/components/landing/draft-testimonial'
import { Hero as LandingHero } from '@/components/landing/hero'
import { HomepageLiveStreams } from '@/components/landing/homepage-live-streams'
import { Manifesto } from '@/components/landing/manifesto'
import {
	PersonalizedNewsletterSection,
	PersonalizedSlimNewsletterForm,
} from '@/components/landing/personalized-newsletter-section'
import { ProofGrid, ProofQuote } from '@/components/landing/proof-grid'
import { SkillsCourseCta } from '@/components/landing/skills-course-cta'
import { Prose } from '@/components/landing/prose'
import { Resource, ResourceGrid } from '@/components/landing/resource'
import {
	SectionHeading,
	YellowStrong,
} from '@/components/landing/section-heading'
import { SectionHeader } from '@/components/landing/section-header'
import { SectionLink } from '@/components/landing/section-link'
import { SkillsShowcase } from '@/components/landing/skills-showcase'
import { SplitRow } from '@/components/landing/split-row'
import { TestimonialDivider } from '@/components/landing/testimonial-divider'
import { TopicsGrid, TopicsGridColumn } from '@/components/landing/topics-grid'
import { UpcomingCohort } from '@/components/landing/upcoming-cohort'
import { SubscriberCount } from '@/components/subscriber-count'
import { compileMDX } from '@/utils/compile-mdx'

/**
 * The homepage's MDX component map and page chrome, shared by the real
 * homepage (body from the CMS) and `/preview/landing` (body from
 * `content/landing.md` on disk). One map, so a component registered for one
 * surface can never be missing on the other.
 */
export async function LandingBody({
	source,
	previewLiveStreams = false,
}: {
	source: string
	previewLiveStreams?: boolean
}) {
	async function Hero(
		props: React.ComponentProps<typeof LandingHero> & {
			previewLiveStreams?: boolean
		},
	) {
		const { previewLiveStreams: _ignored, ...heroProps } = props
		return (
			<>
				<LandingHero {...heroProps} />
				<HomepageLiveStreams preview={previewLiveStreams} />
			</>
		)
	}

	const components = {
		Hero,
		Resource,
		ResourceGrid,
		UpcomingCohort,
		Manifesto,
		AboutMatt,
		CompanyLogoGrid,
		// The panel goes when the ask inside it goes. `NewsletterSection` is
		// chrome — an eyebrow, a headline, a subtitle — around whichever CTA the
		// body puts in it, and on its own it is a bordered box making a promise
		// with no way to accept it.
		NewsletterSection: PersonalizedNewsletterSection,
		NewsletterCta: PersonalizedSlimNewsletterForm,
		// The same ask, pointed at the free seven-lesson email course rather than
		// list. Both are registered so a section can choose which offer it makes.
		CourseCta: SkillsCourseCta,
		Testimonial: DraftTestimonial,
		TestimonialDivider,
		ProofGrid,
		ProofQuote,
		TopicsGrid,
		TopicsGridColumn,
		SkillsShowcase,
		SplitRow,
		ActivityLadder,
		ActivityRung,
		SectionHeader,
		SectionLink,
		SubscriberCount,
		Prose,
		h2: SectionHeading,
		strong: YellowStrong,
	}

	const compiled = await compileMDX(source, components as any)

	return (
		<main className="bg-background text-foreground">
			{/* SEPARATORS ARE THE CONTAINER'S JOB, not each section's.

			    Sections used to hand-manage `border-t` / `border-b` / `border-y`,
			    which meant every reorder risked a doubled rule (two adjacent
			    `border-y`s) or none at all (two `border-b`-less neighbours), and
			    both kept happening.

			    Here every child after the first draws the rule above itself, and
			    every child but the last gives up its own `border-b`. So each
			    boundary has exactly one rule, whatever the two sections declare:
			    a child that already has `border-t` sets the same property, and a
			    `border-b` above it is gone. Sections can be moved, added or
			    removed in the CMS body without anyone touching a border.

			    The `border-b` used to stay, pulled under the next child's rule
			    with `-mt-px`. That only hides it when the lower section paints a
			    background. The rule colour is translucent, so between two plain
			    sections the pair showed through as one rule at twice the
			    strength: the hero's and the manifesto's, for one. */}
			{/* The company band used to be hardcoded here, after the MDX, which
			    put it after the newsletter at the very tail of the page. The
			    prototype has it inside PROOF (`Home Page.dc.html` § PROOF), so
			    `ProofGrid` renders it now and the page ends on MATT +
			    NEWSLETTER. */}
			<article className="[&>*+*]:border-border [&>*+*]:border-t [&>*:not(:last-child)]:border-b-0">
				{compiled.content}
			</article>
		</main>
	)
}
