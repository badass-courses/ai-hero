import { Suspense } from 'react'
import { type Metadata, type ResolvingMetadata } from 'next'
import { unstable_cache } from 'next/cache'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
	OrganicOpportunityCta,
	organicOpportunityCtaBySlug,
} from '@/app/(content)/_components/organic-opportunity-cta'
import { ContentReadTracker } from '@/components/content-read-tracker'
import { Contributor } from '@/components/contributor'
import { PlayerContainerSkeleton } from '@/components/player-skeleton'
import { PrimaryNewsletterCta } from '@/components/primary-newsletter-cta'
import { Share } from '@/components/share'
import { courseBuilderAdapter } from '@/db'
import { getAiCodingDictionary } from '@/lib/ai-coding-dictionary'
import { getAllLists, getCachedListForPost } from '@/lib/lists-query'
import { type Post } from '@/lib/posts'
import { getAllPosts, getCachedPostOrList } from '@/lib/posts-query'
import { PostStructuredData } from '@/lib/structured-data'
import { getServerAuthSession } from '@/server/auth'
import { compileMDX } from '@/utils/compile-mdx'
import { getOGImageUrlForResource } from '@/utils/get-og-image-url-for-resource'
import { ArrowLeft, Github } from 'lucide-react'
import ReactMarkdown from 'react-markdown'

import { ContentResourceResource } from '@coursebuilder/core/schemas'
import { Button } from '@coursebuilder/ui'
import { VideoPlayerOverlayProvider } from '@coursebuilder/ui/hooks/use-video-player-overlay'
import { cn } from '@coursebuilder/utils/cn'

import { CopyPageButton } from '../_components/copy-page-button'
import PostNextUpFromListPagination from '../_components/post-next-up-from-list-pagination'
import ListPage from '../lists/[slug]/_page'
import { PostPlayer } from '../posts/_components/post-player'
import PostToC from '../posts/_components/post-toc'
import { PostNewsletterCta } from '../posts/_components/post-video-subscribe-form'
import {
	PostShareDialogButton,
	PostSubscribeDialogButton,
} from './_components/post-header-dialog-buttons'
import { PostNextLessonButton } from './_components/post-next-lesson-button'

type Props = {
	params: Promise<{ post: string }>
}

export default async function PostPage(props: {
	params: Promise<{ post: string }>
}) {
	const params = await props.params

	const post = await getCachedPostOrList(params.post)

	if (!post) {
		notFound()
	}

	if (post.type === 'list') {
		return <ListPage list={post} params={{ slug: params.post } as any} />
	}

	let list = null
	if (post && post.type === 'post') {
		list = await getCachedListForPost(params.post)
	}

	const hasVideo = post?.resources?.find(
		({ resource }: ContentResourceResource) =>
			resource.type === 'videoResource',
	)
	const markdownToCopy = `# ${post?.fields?.title}

${post?.fields?.body}`

	return (
		<main className="bg-card w-full dark:bg-transparent">
			<ContentReadTracker
				contentId={post.id}
				contentType="post"
				contentSlug={String(post.fields?.slug ?? params.post)}
			/>
			<PostStructuredData post={post} />
			{hasVideo && <PlayerContainer post={post} />}
			<div
				className={cn('relative w-full', {
					'': !hasVideo,
				})}
			>
				{/* {list ? (
					<div className="pt-6 sm:pt-10" />
				) : (
					<div
						className={cn(
							'relative z-10 mx-auto flex w-full items-center justify-between px-5 py-3',
							{
								'mb-10 sm:mb-14': !hasVideo,
								'mb-6 sm:mb-6': hasVideo,
							},
						)}
					>
						<Link
							href="/posts"
							className="text-foreground/75 hover:text-primary group inline-flex items-center text-xs transition duration-300 ease-in-out sm:text-sm"
						>
							<ArrowLeft className="mr-1 size-4 transition-transform duration-200 ease-out group-hover:-translate-x-0.5" />{' '}
							All Posts
						</Link>
					</div>
				)} */}
				<div className="relative z-10">
					<article className="relative flex h-full flex-col">
						<div className="bg-card mx-auto flex w-full flex-col gap-3 px-8 pb-5 pt-6">
							<PostTitle post={post} />
							<div className="relative mb-3 flex w-full items-center justify-between gap-3">
								<div className="flex w-full flex-wrap items-center justify-between gap-5">
									<div className="flex flex-wrap items-center gap-3">
										<Contributor className="text-foreground flex text-sm font-medium [&_img]:w-8" />
										<PostSubscribeDialogButton postSlug={post.fields?.slug} />
									</div>
									<div
										className={cn('flex flex-wrap items-center gap-2', {
											'grid w-full grid-cols-2 sm:flex sm:w-auto':
												post.fields?.github,
										})}
									>
										{post.fields?.github && (
											<Button
												asChild
												size="default"
												variant="ghost"
												className="rounded-full border"
											>
												<Link href={post.fields?.github} target="_blank">
													<Github className="text-muted-foreground size-4" />
													Source Code
												</Link>
											</Button>
										)}
										{post.fields?.body && (
											<CopyPageButton
												variant="ghost"
												className="rounded-full border"
												markdown={markdownToCopy}
											/>
										)}
										<PostShareDialogButton title={post.fields?.title} />

										<PostNextLessonButton postId={post.id} />
									</div>
								</div>
								<Suspense fallback={null}>
									<PostActionBar post={post} />
								</Suspense>
							</div>
						</div>
						{post?.type === 'post' && post?.fields?.body && (
							<PostToC markdown={post.fields.body} />
						)}
						<PostBody post={post} />
						{/* {listSlugFromParam && (
									<PostProgressToggle
										className="flex w-full items-center justify-center"
										postId={post.id}
									/>
								)} */}
						{!hasVideo && (
							<PrimaryNewsletterCta
								isHiddenForSubscribers
								className="mt-20 border-t pt-14 sm:pb-5 sm:pt-20"
								trackProps={{
									event: 'subscribed',
									params: {
										post: post.fields.slug,
										location: 'post',
									},
								}}
							/>
						)}
						<div className="mx-auto mt-16 flex w-full flex-wrap items-center justify-center gap-5 border-t pl-5">
							<strong className="text-lg font-semibold">Share</strong>
							<Share
								className="inline-flex rounded-none border-y-0"
								title={post?.fields.title}
							/>
						</div>
						<PostNextUpFromListPagination
							postId={post.id}
							documentIdsToSkip={list?.resources.map(
								(resource: any) => resource.resource.id,
							)}
						/>
					</article>
				</div>
			</div>
			{/* {ckSubscriber && product && allowPurchase && pricingDataLoader ? (
						<section id="buy">
							<h2 className="text-2xl mb-10 text-balance px-5 text-center font-bold">
								Get Really Good At Node.js
							</h2>
							<div className="flex items-center justify-center border-y">
								<div className="bg-background flex w-full max-w-md flex-col border-x p-8">
									<PricingWidget
										quantityAvailable={-1}
										pricingDataLoader={pricingDataLoader}
										commerceProps={{ ...commerceProps }}
										product={product}
									/>
								</div>
							</div>
						</section>
					) : hasVideo ? null : ( */}
		</main>
	)
}

async function PostBody({ post }: { post: Post | null }) {
	if (!post) {
		return null
	}

	if (!post.fields.body) {
		return null
	}

	const dictionary = await getAiCodingDictionary()
	const slug = String(post.fields?.slug ?? '')
	const ctaKind = organicOpportunityCtaBySlug[slug]
	const { content } = await compileMDX(
		post.fields.body,
		{},
		{},
		{
			lessonId: post.id,
			dictionaryAutoLink: {
				entries: dictionary.entries,
				maxLinks: 3,
			},
		},
	)

	return (
		<div className="px-5 md:px-10 lg:px-10">
			<article className="prose prose-hr:border-border dark:prose-invert prose-a:text-primary sm:prose-lg lg:prose-lg mx-auto mt-10 max-w-4xl">
				{content}
				{ctaKind ? <OrganicOpportunityCta kind={ctaKind} /> : null}
			</article>
		</div>
	)
}

async function PostTitle({ post }: { post: Post | null }) {
	return (
		<h1 className="text-3xl font-bold leading-tight tracking-tight sm:text-4xl lg:text-4xl dark:text-white">
			<ReactMarkdown
				components={{
					p: ({ children }) => children,
					code: ({ children }) => (
						<code className="bg-muted/80 rounded px-1 text-[85%]">
							{children}
						</code>
					),
				}}
			>
				{post?.fields?.title}
			</ReactMarkdown>
		</h1>
	)
}

/**
 * Video lookups go through PlanetScale (no-store fetch). Wrapping in
 * unstable_cache contains that no-store inside a cache boundary so the page
 * can still be statically prerendered — without this the build's prerender
 * pass throws "Dynamic server usage" via the drizzle adapter's catch-and-
 * rethrow path and fails the build.
 */
const _getCachedVideoResource = (id: string) =>
	unstable_cache(
		async () => courseBuilderAdapter.getVideoResource(id),
		['post-video-resource-v1', id],
		{ revalidate: 3600, tags: [`video-resource:${id}`] },
	)()

async function PlayerContainer({ post }: { post: Post | null }) {
	if (!post) {
		notFound()
	}

	const resource = post.resources?.[0]?.resource.id

	const videoResource = resource
		? await _getCachedVideoResource(resource)
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
					className="flex flex-col items-center justify-center border-b bg-black"
				>
					<PostPlayer
						title={post.fields?.title}
						thumbnailTime={post.fields?.thumbnailTime || 0}
						postId={post.id}
						className="flex aspect-video h-full max-h-[75vh] w-full items-center justify-center overflow-hidden"
						videoResource={videoResource}
					/>
					{/* <PostNewsletterCta
						trackProps={{
							event: 'subscribed',
							params: {
								location: 'post-below-video',
								post: post.fields.slug,
							},
						}}
					/> */}
				</section>
			</Suspense>
		</VideoPlayerOverlayProvider>
	) : null
}

export async function generateStaticParams() {
	const posts = await getAllPosts()
	const lists = await getAllLists()

	const resources = [...posts, ...lists]

	return resources
		.filter((resource) => Boolean(resource.fields?.slug))
		.map((resource) => ({
			post: resource.fields?.slug,
		}))
}

export async function generateMetadata(
	props: Props,
	parent: ResolvingMetadata,
): Promise<Metadata> {
	const params = await props.params

	const resource = await getCachedPostOrList(params.post)

	if (!resource) {
		return parent as Metadata
	}

	return {
		title: resource.fields.title,
		description: resource.fields.description,
		alternates: {
			canonical: `/${resource.fields.slug}`,
		},
		openGraph: {
			images: [
				getOGImageUrlForResource({
					fields: { slug: resource.fields.slug },
					id: resource.id,
					updatedAt: resource.updatedAt,
				}),
			],
		},
	}
}

async function PostActionBar({ post }: { post: Post | null }) {
	const { session, ability } = await getServerAuthSession()

	return (
		<>
			{post && ability.can('update', 'Content') ? (
				<Button asChild size="sm" className="absolute right-0 top-0 z-50">
					<Link href={`/posts/${post.fields?.slug || post.id}/edit`}>Edit</Link>
				</Button>
			) : null}
		</>
	)
}
