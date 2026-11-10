import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { TeamInquiryForm } from '@/components/team-inquiry/team-inquiry-form'

import { cn } from '@coursebuilder/utils/cn'

export const dynamic = 'force-static'

export const metadata: Metadata = {
	title: 'Training Partners | AI Hero',
	description:
		'Licensed partners who deliver AI Hero training live, with an instructor, for your team.',
}

type Partner = {
	name: string
	line: string
	logo: { light: string; dark: string; width: number; height: number }
}

/**
 * Licensed partners who run live, instructor-led AI Hero trainings. Static on
 * purpose: two entries do not need a CMS or a data model. Logos are vetted
 * SVGs from each partner's own site or logo pack.
 *
 * No outbound links or contact details: every request goes through the
 * inquiry form so AI Hero sees each lead and routes it (Joel, 2026-11-02).
 * The partner agreements require a listing, not a link.
 */
const PARTNERS: Partner[] = [
	{
		name: 'inovex',
		line: 'Live, instructor-led AI Hero trainings in Germany and Switzerland.',
		logo: {
			light: '/partners/inovex-logo.svg',
			dark: '/partners/inovex-logo-white.svg',
			width: 92,
			height: 64,
		},
	},
	{
		name: 'This Dot Labs',
		line: 'Live, instructor-led AI Hero trainings.',
		logo: {
			light: '/partners/thisdot-labs-logo.svg',
			dark: '/partners/thisdot-labs-logo.svg',
			width: 198,
			height: 48,
		},
	},
]

export default function TrainingPartnersPage() {
	return (
		<LayoutClient withContainer>
			<main className="bg-background text-foreground min-h-[calc(100vh-var(--nav-height))] border-x">
				<section className="border-b">
					<div className="flex flex-col gap-6 px-[18px] pb-11 pt-12 sm:px-11">
						<h1 className={cn(TYPE.title, 'text-balance')}>
							Training Partners
						</h1>
						<p className={cn(TYPE.lead, 'text-muted-foreground max-w-[65ch]')}>
							Want AI Hero training delivered live by an instructor for your
							team? These partners are licensed to run it.
						</p>
					</div>
				</section>

				<section aria-label="Team inquiry" className="border-b">
					<div className="mx-auto max-w-2xl px-[18px] py-12 sm:px-11">
						<TeamInquiryForm
							location="/training-partners"
							source="training-partners"
						/>
					</div>
				</section>

				<section aria-label="Training partners">
					<ul className="bg-border flex flex-col gap-px">
						{PARTNERS.map((partner) => (
							<li key={partner.name} className="bg-background">
								<div className="flex flex-col gap-5 px-[18px] py-8 sm:flex-row sm:items-center sm:justify-between sm:px-11 md:py-10">
									<div className="flex flex-col gap-2">
										<h2 className="text-xl font-semibold">{partner.name}</h2>
										<p className="text-muted-foreground max-w-[55ch]">
											{partner.line}
										</p>
									</div>
									<Image
										src={partner.logo.light}
										alt={`${partner.name} logo`}
										width={partner.logo.width}
										height={partner.logo.height}
										unoptimized
										className={cn(
											'h-12 w-auto sm:h-16',
											partner.logo.dark !== partner.logo.light && 'dark:hidden',
										)}
									/>
									{partner.logo.dark !== partner.logo.light ? (
										<Image
											src={partner.logo.dark}
											alt=""
											aria-hidden
											width={partner.logo.width}
											height={partner.logo.height}
											unoptimized
											className="hidden h-12 w-auto sm:h-16 dark:block"
										/>
									) : null}
								</div>
							</li>
						))}
					</ul>
				</section>

				<section className="border-t">
					<div className="px-[18px] py-8 sm:px-11">
						<p className="text-muted-foreground">
							Prefer self-paced seats for your team?{' '}
							<Link
								href="/for-your-team"
								className="text-foreground font-medium underline underline-offset-4"
							>
								Buy them directly
							</Link>
							.
						</p>
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}
