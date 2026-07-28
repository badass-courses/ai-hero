import * as React from 'react'
import { AboutMatt } from '@/components/landing/about-matt'
import { ActivityLadder } from '@/components/landing/activity-ladder'
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
		ActivityLadder,
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
			<article>{compiled.content}</article>
			{/* Stays hardcoded outside the MDX by design. */}
			<section className="border-border mx-auto w-full border-y pt-7">
				<CompanyLogoGrid />
			</section>
		</main>
	)
}
