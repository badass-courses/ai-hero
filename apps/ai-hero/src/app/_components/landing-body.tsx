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
import { NewsletterSection } from '@/components/landing/newsletter-section'
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
import { SlimNewsletterForm } from '@/components/landing/slim-newsletter-form'
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
		NewsletterSection,
		NewsletterCta: () => <SlimNewsletterForm />,
		Testimonial: DraftTestimonial,
		TestimonialDivider,
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
			    
			    Here every child after the first draws its own top rule and pulls up
			    1px. Two consequences make this reorder-proof: a child that already
			    declares `border-t` sets the same property, so it cannot double; and
			    a previous child's `border-b` ends up underneath the next child's
			    `border-t` rather than stacking with it. Sections can be moved,
			    added or removed in the CMS body without anyone touching a border.
			    
			    This is the `-mt-px` idiom `ResourceRow` already used to stack
			    consecutive rows, generalised to the whole page. */}
			<article className="[&>*+*]:border-border [&>*+*]:-mt-px [&>*+*]:border-t">
				{compiled.content}
			</article>
			{/* Stays hardcoded outside the MDX by design. */}
			<section className="border-border mx-auto w-full border-t pt-7">
				<CompanyLogoGrid />
			</section>
		</main>
	)
}
