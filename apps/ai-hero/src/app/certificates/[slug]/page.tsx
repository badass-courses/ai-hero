import { cache } from 'react'
import type { Metadata } from 'next'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import {
	buildSkillsWorkflowCertificateShareImageUrl,
	buildSkillsWorkflowCertificateShareUrl,
	getPublicSkillsWorkflowCertificateShare,
	SKILLS_WORKFLOW_FREE_COURSE_PATH,
} from '@/lib/subscriber-marketing/value-path-certificate-shares'
import { format } from 'date-fns'
import { ArrowRight } from 'lucide-react'

const getCertificateShare = cache(getPublicSkillsWorkflowCertificateShare)

type CertificatePageProps = {
	params: Promise<{ slug: string }>
}

export async function generateMetadata({
	params,
}: CertificatePageProps): Promise<Metadata> {
	const { slug } = await params
	const share = await getCertificateShare(slug)
	if (!share) return {}

	const baseUrl = process.env.NEXT_PUBLIC_URL ?? 'https://www.aihero.dev'
	const canonicalUrl = buildSkillsWorkflowCertificateShareUrl({
		slug: share.slug,
		baseUrl,
	})
	const ogImageUrl = new URL(
		`${buildSkillsWorkflowCertificateShareUrl({ slug: share.slug })}/og`,
		baseUrl,
	).toString()
	const title = `${share.learnerName} completed the ${share.courseName}`
	const description = `${share.learnerName} completed the ${share.courseName} with AI Hero.`

	return {
		title,
		description,
		alternates: { canonical: canonicalUrl },
		robots: { index: false, follow: false },
		openGraph: {
			title,
			description,
			url: canonicalUrl,
			siteName: 'AI Hero',
			type: 'article',
			images: [
				{
					url: ogImageUrl,
					width: 1200,
					height: 630,
					alt: `${share.learnerName}'s ${share.courseName} certificate`,
				},
			],
		},
		twitter: {
			card: 'summary_large_image',
			title,
			description,
			images: [ogImageUrl],
		},
	}
}

export default async function PublicCertificatePage({
	params,
}: CertificatePageProps) {
	const { slug } = await params
	const share = await getCertificateShare(slug)
	if (!share) notFound()

	const imageUrl = buildSkillsWorkflowCertificateShareImageUrl({
		slug: share.slug,
	})

	return (
		<LayoutClient
			withContainer
			withNavigation={false}
			withFooter={false}
			className="min-h-screen"
		>
			<main className="bg-background text-foreground min-h-screen">
				<section className="border-border border-b">
					<div className="px-8 py-16 sm:px-16 md:py-24 lg:px-24">
						<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
							AI Hero certificate of completion
						</p>
						<h1 className="mt-4 max-w-4xl text-balance text-4xl font-medium leading-tight tracking-tight sm:text-5xl lg:text-6xl">
							{share.learnerName}
						</h1>
						<p className="mt-4 max-w-3xl text-xl leading-relaxed opacity-80 sm:text-2xl">
							Completed the {share.courseName} on{' '}
							<time dateTime={share.completedAt.toISOString()}>
								{format(share.completedAt, 'MMMM d, yyyy')}
							</time>
							.
						</p>
					</div>
				</section>

				<section className="border-border border-b">
					<div className="px-4 py-16 sm:px-8 md:py-24 lg:px-16">
						<div className="border-border bg-card border p-1 sm:p-2">
							<Image
								alt={`${share.learnerName}'s ${share.courseName} certificate`}
								className="h-auto w-full"
								height={1190}
								priority
								src={imageUrl}
								unoptimized
								width={1684}
							/>
						</div>
					</div>
				</section>

				<section>
					<div className="grid gap-8 px-8 py-16 sm:px-16 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:gap-16 md:py-24 lg:px-24">
						<p className="font-mono text-[11px] font-medium uppercase tracking-wider opacity-60">
							Build yours
						</p>
						<div className="space-y-6">
							<h2 className="text-balance text-3xl font-medium leading-tight tracking-tight sm:text-4xl">
								Build a workflow you can trust on real engineering work.
							</h2>
							<a
								className="focus-visible:ring-ring focus-visible:ring-offset-background bg-primary text-primary-foreground inline-flex min-h-12 items-center justify-center gap-2 px-6 py-3 text-base font-semibold transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
								href={SKILLS_WORKFLOW_FREE_COURSE_PATH}
							>
								Start the free course
								<ArrowRight aria-hidden="true" className="size-4" />
							</a>
						</div>
					</div>
				</section>
			</main>
		</LayoutClient>
	)
}
