// import { promises as fs } from 'node:fs'
// import path from 'node:path'
import type { Metadata, ResolvingMetadata } from 'next'
import { AboutMatt } from '@/components/landing/about-matt'
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
import { SkillCycleSection } from '@/components/landing/skill-cycle-section'
import { SlimNewsletterForm } from '@/components/landing/slim-newsletter-form'
import { TestimonialDivider } from '@/components/landing/testimonial-divider'
import {
	TopicsGrid,
	TopicsGridColumn,
} from '@/components/landing/topics-grid'
import { UpcomingCohort } from '@/components/landing/upcoming-cohort'
import LayoutClient from '@/components/layout-client'
import { SubscriberCount } from '@/components/subscriber-count'
import config from '@/config'
import { courseBuilderAdapter } from '@/db'
import { getPage } from '@/lib/pages-query'
import { compileMDX } from '@/utils/compile-mdx'

import { getCouponForCode } from '@coursebuilder/core/lib/pricing/props-for-commerce'

type Props = {
	searchParams: Promise<{ [key: string]: string | undefined }>
}

async function Hero(
	props: React.ComponentProps<typeof LandingHero> & {
		previewLiveStreams?: boolean
	},
) {
	const { previewLiveStreams, ...heroProps } = props

	return (
		<>
			<LandingHero {...heroProps} />
			<HomepageLiveStreams preview={previewLiveStreams} />
		</>
	)
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

// async function loadDraftMarkdown() {
// 	const filePath = path.join(process.cwd(), 'content', 'landing.md')
// 	return await fs.readFile(filePath, 'utf-8')
// }

export default async function DraftLandingPage(props: Props) {
	const searchParams = await props.searchParams
	// W4 revision lives in its own CMS row. The homepage body is loaded from the
	// SHARED PROD DB at runtime, so editing `landing-page` would change the live
	// site the moment it saved, before this branch deploys. `landing-page-v2` is
	// published + unlisted; `landing-page` stays untouched as the rollback.
	const page = await getPage('landing-page-v2')
	const source = page?.fields.body ?? ''
	const previewLiveStreams =
		process.env.NODE_ENV !== 'production' && searchParams?.livePreview === '1'

	const components = {
		Hero: (props: React.ComponentProps<typeof LandingHero>) => (
			<Hero {...props} previewLiveStreams={previewLiveStreams} />
		),
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
		SkillCycleSection,
		SubscriberCount,
		Prose,
		h2: SectionHeading,
		strong: YellowStrong,
	}

	const compiled = await compileMDX(source, components as any)

	return (
		<LayoutClient withContainer>
			<main className="bg-background text-foreground">
				<article>{compiled.content}</article>
				{/* Stays hardcoded outside the MDX by design. */}
				<section className="border-border mx-auto w-full border-y pt-7">
					<CompanyLogoGrid />
				</section>
				{/* W4: the hardcoded "Get the practical AI coding workflow notes"
				    block was cut here. It was a THIRD newsletter capture, outside the
				    CMS body and absent from the wireframe, competing with the two
				    intentional capture points and the skills course CTA. */}
			</main>
		</LayoutClient>
	)
}
