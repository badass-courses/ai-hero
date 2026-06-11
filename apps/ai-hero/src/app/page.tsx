// import { promises as fs } from 'node:fs'
// import path from 'node:path'
import type { Metadata, ResolvingMetadata } from 'next'
import Link from 'next/link'
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
import { SlimNewsletterForm } from '@/components/landing/slim-newsletter-form'
import { UpcomingCohort } from '@/components/landing/upcoming-cohort'
import LayoutClient from '@/components/layout-client'
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
	const page = await getPage('landing-page') // loadDraftMarkdown()
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
		Prose,
		h2: SectionHeading,
		strong: YellowStrong,
	}

	const compiled = await compileMDX(source, components as any)

	return (
		<LayoutClient withContainer>
			<main className="bg-background text-foreground">
				<article>{compiled.content}</article>
				<section className="border-border mx-auto w-full border-y pt-7">
					<CompanyLogoGrid />
				</section>
				<section className="border-border mx-auto w-full py-14">
					<div className="flex flex-col gap-4 px-5 text-center sm:px-8 lg:px-10">
						<p className="text-muted-foreground text-center text-xs font-medium uppercase tracking-wider">
							AI Skills for Real Engineers
						</p>
						<h2 className="text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
							Get the practical AI coding workflow notes.
						</h2>
						<p className="text-muted-foreground mx-auto max-w-2xl text-balance text-base sm:text-lg">
							Short updates on skills, handoffs, testing, code review, and the
							parts of AI-assisted engineering that survive contact with real
							code.
						</p>
						<div className="flex justify-center pt-3">
							<Link
								href="/skills/subscribe"
								className="bg-primary text-primary-foreground hover:bg-primary/90 h-13 inline-flex items-center px-5 text-base font-medium transition"
							>
								Subscribe to the Skills newsletter
							</Link>
						</div>
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}
