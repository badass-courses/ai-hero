import { Suspense } from 'react'
import type { Metadata, ResolvingMetadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
	OrganicOpportunityCta,
	organicOpportunityCtaBySlug,
} from '@/app/(content)/_components/organic-opportunity-cta'
import { ContentReadTracker } from '@/components/content-read-tracker'
import { Contributor } from '@/components/contributor'
import LayoutClient from '@/components/layout-client'
import { MdxErrorBoundary } from '@/components/mdx/mdx-error-boundary'
import { PlayerContainerSkeleton } from '@/components/player-skeleton'
import { Share } from '@/components/share'
import { courseBuilderAdapter } from '@/db'
import {
	getCachedSkillChangelogEntry,
	getSkillChangelogEntries,
} from '@/lib/skill-changelog-query'
import {
	ArticleStructuredData,
	BreadcrumbStructuredData,
} from '@/lib/structured-data'
import { getServerAuthSession } from '@/server/auth'
import { compileMDX } from '@/utils/compile-mdx'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'
import { ArrowLeft, Github } from 'lucide-react'

import { ContentResourceResource } from '@coursebuilder/core/schemas'
import { Button } from '@coursebuilder/ui'
import { VideoPlayerOverlayProvider } from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/utils/cn'

import { CopyPageButton } from '../../_components/copy-page-button'
import { PostShareDialogButton } from '../../[post]/_components/post-header-dialog-buttons'
import { PostPlayer } from '../../posts/_components/post-player'
import { SkillsCourseCta } from '../_components/skills-course-cta'

type Props = {
	params: Promise<{ slug: string }>
}

export default async function SkillChangelogEntryPage({ params }: Props) {
	const { slug } = await params
	const entry = await getCachedSkillChangelogEntry(slug)

	if (!entry) {
		notFound()
	}

	const hasVideo = entry.resources?.find(
		({ resource }: ContentResourceResource) =>
			resource.type === 'videoResource',
	)
	const markdownToCopy = `# ${entry.fields?.title}

${entry.fields?.body ?? ''}`

	return (
		<LayoutClient withContainer>
			<main className="bg-card w-full dark:bg-transparent">
				<ArticleStructuredData
					resource={entry}
					canonicalPath={`/skills/${entry.fields?.slug ?? slug}`}
					section="AI Skills Changelog"
				/>
				<BreadcrumbStructuredData
					items={[
						{ name: 'Home', path: '/' },
						{ name: 'AI Skills', path: '/skills' },
						{
							name: String(entry.fields?.title ?? 'AI Skills Changelog'),
							path: `/skills/${entry.fields?.slug ?? slug}`,
						},
					]}
				/>
				<ContentReadTracker
					contentId={entry.id}
					contentType="skill-changelog"
					contentSlug={String(entry.fields?.slug ?? slug)}
				/>
				{hasVideo && <PlayerContainer entry={entry} />}
				<div
					className={cn('relative w-full', {
						'pt-6 sm:pt-14': !hasVideo,
					})}
				>
					<div className="relative z-10 mx-auto flex w-full items-center justify-between px-5 md:px-10 lg:px-14">
						<Link
							href="/skills"
							className="text-foreground/75 hover:text-foreground mb-3 inline-flex items-center gap-2 text-sm transition duration-300 ease-in-out"
						>
							<ArrowLeft className="size-4" /> AI Skills Changelog
						</Link>
					</div>
					<article className="relative flex h-full flex-col">
						<div className="mx-auto flex w-full flex-col gap-5 px-5 md:px-10 lg:px-14">
							<h1 className="mb-4 text-2xl font-semibold sm:text-3xl lg:text-4xl dark:text-white">
								{entry.fields?.title}
							</h1>
							<div className="relative mb-3 flex w-full items-center justify-between gap-3">
								<div className="flex w-full flex-wrap items-center gap-5">
									<Contributor className="flex [&_img]:w-8" />
									<div className="flex flex-wrap items-center gap-2">
										{entry.fields?.github && (
											<Button
												asChild
												size="default"
												variant="ghost"
												className="rounded-full border"
											>
												<Link href={entry.fields.github} target="_blank">
													<Github className="text-muted-foreground size-4" />
													Source Code
												</Link>
											</Button>
										)}
										{entry.fields?.body && (
											<CopyPageButton
												variant="ghost"
												className="rounded-full border"
												markdown={markdownToCopy}
											/>
										)}
										<PostShareDialogButton
											title={String(entry.fields?.title ?? '')}
										/>
									</div>
								</div>
								<Suspense fallback={null}>
									<SkillChangelogActionBar entry={entry} />
								</Suspense>
							</div>
						</div>
						<SkillChangelogBody
							body={entry.fields?.body}
							slug={String(entry.fields?.slug ?? slug)}
						/>
						{!hasVideo ? (
							<div className="mx-auto w-full max-w-4xl px-5 pt-20 md:px-10 lg:px-14">
								<SkillsCourseCta />
							</div>
						) : null}
						<div className="mx-auto mt-16 flex w-full flex-wrap items-center justify-center gap-5 border-t pl-5">
							<strong className="text-lg font-semibold">Share</strong>
							<Share
								className="inline-flex rounded-none border-y-0"
								title={String(entry.fields?.title ?? '')}
							/>
						</div>
					</article>
				</div>
			</main>
		</LayoutClient>
	)
}

/**
 * Renders compiled skill changelog MDX with an optional organic opportunity CTA.
 *
 * @param body - Raw MDX body. Returns null when it is not a non-empty string.
 * @param slug - Skill changelog slug used to select a contextual CTA.
 * @returns Null for empty bodies, otherwise a JSX element containing compiled MDX and optional OrganicOpportunityCta.
 */
async function SkillChangelogBody({
	body,
	slug,
}: {
	body?: unknown
	slug: string
}) {
	if (typeof body !== 'string' || body.length === 0) {
		return null
	}

	const ctaKind = organicOpportunityCtaBySlug[slug]
	const { content } = await compileMDX(body, {}, {})

	return (
		<div className="px-5 md:px-10 lg:px-14">
			<article className="prose prose-hr:border-border dark:prose-invert prose-a:text-primary sm:prose-lg lg:prose-lg prose-p:max-w-4xl prose-headings:max-w-4xl prose-ul:max-w-4xl prose-table:max-w-4xl prose-pre:max-w-4xl **:data-pre:max-w-4xl mt-10 max-w-none">
				<MdxErrorBoundary>{content}</MdxErrorBoundary>
				{ctaKind ? <OrganicOpportunityCta kind={ctaKind} /> : null}
			</article>
		</div>
	)
}

async function PlayerContainer({
	entry,
}: {
	entry: NonNullable<Awaited<ReturnType<typeof getCachedSkillChangelogEntry>>>
}) {
	const resource = entry.resources?.[0]?.resource.id
	const videoResource = resource
		? await courseBuilderAdapter.getVideoResource(resource)
		: null

	return videoResource ? (
		<VideoPlayerOverlayProvider>
			<Suspense
				fallback={
					<PlayerContainerSkeleton className="aspect-video h-full max-h-[75vh] w-full bg-black" />
				}
			>
				<section
					aria-label="video"
					className="mb-6 flex flex-col items-center justify-center border-b bg-black sm:mb-10"
				>
					<PostPlayer
						title={String(entry.fields?.title ?? '')}
						thumbnailTime={Number(entry.fields?.thumbnailTime ?? 0)}
						postId={entry.id}
						className="aspect-video h-full max-h-[75vh] w-full overflow-hidden"
						videoResource={videoResource}
					/>
					<div className="bg-background w-full px-5 py-8 md:px-10 lg:px-14">
						<SkillsCourseCta className="mx-auto max-w-4xl" />
					</div>
				</section>
			</Suspense>
		</VideoPlayerOverlayProvider>
	) : null
}

async function SkillChangelogActionBar({
	entry,
}: {
	entry: NonNullable<Awaited<ReturnType<typeof getCachedSkillChangelogEntry>>>
}) {
	const { ability } = await getServerAuthSession()

	return entry && ability.can('update', 'Content') ? (
		<Button asChild size="sm" className="absolute right-0 top-0 z-50">
			<Link href={`/skills/${entry.fields?.slug || entry.id}/edit`}>Edit</Link>
		</Button>
	) : null
}

export async function generateStaticParams() {
	const entries = await getSkillChangelogEntries({ limit: 100 })

	return entries
		.filter((entry) => Boolean(entry.fields?.slug))
		.map((entry) => ({
			slug: entry.fields?.slug,
		}))
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const { slug } = await props.params
	const entry = await getCachedSkillChangelogEntry(slug)

	if (!entry) {
		return parent as Metadata
	}

	return {
		title: String(entry.fields?.title ?? 'AI Skills Changelog'),
		description:
			typeof entry.fields?.description === 'string'
				? entry.fields.description
				: undefined,
		alternates: {
			canonical: `/skills/${entry.fields?.slug}`,
		},
		openGraph: {
			images: [
				getOGImageUrlForResource({
					fields: { slug: String(entry.fields?.slug ?? entry.id) },
					id: entry.id,
					updatedAt: entry.updatedAt,
				}),
			],
		},
	}
}
