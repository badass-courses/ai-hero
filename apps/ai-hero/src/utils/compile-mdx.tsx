import { createHash } from 'node:crypto'
import { cache } from 'react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { unstable_rethrow } from 'next/navigation'
import { SkillsCta } from '@/app/(content)/skills/_components/skills-cta'
import { SkillsNewsletterCta } from '@/app/(content)/skills/_components/skills-newsletter-cta'
import {
	CheckList,
	Recommendation,
} from '@/app/admin/pages/_components/page-builder-mdx-components'
import { CldImage, ThemeImage } from '@/components/cld-image'
import { DictionaryHoverLink } from '@/components/dictionary/dictionary-hover-link'
import { AuthorizedOfficeHoursSchedule } from '@/components/mdx/authorized-office-hours-schedule'
import { Heading } from '@/components/mdx/heading'
import { AISummary, TrackLink } from '@/components/mdx/mdx-components'
import { SubscriberCount } from '@/components/subscriber-count'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import type { CalloutIntent } from '@/components/mdx/callout'
import type { CommandCardProps } from '@/components/mdx/command-card'
import type { ComparisonProps } from '@/components/mdx/comparison'
import type { ContrastProps } from '@/components/mdx/contrast'
import { PromoCard } from '@/components/mdx/promo-card'
import type { PromoCardProps } from '@/components/mdx/promo-card'
import type { DictionaryEntry } from '@/lib/ai-coding-dictionary'
import { createCalloutLineAutoInsertRemarkPlugin } from '@/lib/callout-line-autoinsert'
import { createDictionaryAutoLinkRemarkPlugin } from '@/lib/dictionary-autolink'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { rehypeAutoTableWrap } from '@/utils/rehype-auto-table-wrap'
import {
	isInternalPath,
	rehypeInternalLinks,
} from '@/utils/rehype-internal-links'
import { rehypeNumberCheckboxes } from '@/utils/rehype-number-checkboxes'
import { sanitizeMdxSource } from '@/utils/sanitize-mdx-source'
import { recmaCodeHike, remarkCodeHike } from 'codehike/mdx'
import type { CldImageProps } from 'next-cloudinary'
import {
	compileMDX as _compileMDX,
	type MDXRemoteProps,
} from 'next-mdx-remote/rsc'
import rehypeExternalLinks from 'rehype-external-links'
import remarkGfm from 'remark-gfm'

import { LRUCache } from 'lru-cache'

import { remarkMermaid } from '@coursebuilder/mdx-mermaid'
import { Button } from '@coursebuilder/ui'
import { createMdxComponents } from '@coursebuilder/ui/cms/mdx-components'
import { cn } from '@coursebuilder/ui/utils/cn'

import config from '@/config'

const Scrollycoding = dynamic(
	() => import('@/components/codehike/scrollycoding'),
)
const Mermaid = dynamic(() =>
	import('@coursebuilder/mdx-mermaid/client').then((mod) => mod.Mermaid),
)
const Testimonial = dynamic(() =>
	import('@/app/admin/pages/_components/page-builder-mdx-components').then(
		(mod) => mod.Testimonial,
	),
)
const TableWrapper = dynamic(() =>
	import('@/app/admin/pages/_components/page-builder-mdx-components').then(
		(mod) => mod.TableWrapper,
	),
)
const Spoiler = dynamic(() =>
	import('@/app/admin/pages/_components/page-builder-mdx-components').then(
		(mod) => mod.Spoiler,
	),
)
const DynamicCode = dynamic(() =>
	import('@/components/codehike/code').then((mod) => mod.Code),
)
const DynamicMDXVideo = dynamic(() => import('@/components/content/mdx-video'))
const DynamicProjectVideo = dynamic(() =>
	import('@/app/admin/pages/_components/page-builder-mdx-components').then(
		(mod) => mod.ProjectVideo,
	),
)
const DynamicMDXCheckbox = dynamic(() =>
	import('@/components/mdx-checkbox').then((mod) => mod.MDXCheckbox),
)
const CommitMap = dynamic(() =>
	import('@/components/mdx/commit-map').then((mod) => mod.CommitMap),
)
const Commit = dynamic(() =>
	import('@/components/mdx/commit-map').then((mod) => mod.Commit),
)
const CompareTable = dynamic(() =>
	import('@/components/mdx/compare-table').then((mod) => mod.CompareTable),
)
const CompareRow = dynamic(() =>
	import('@/components/mdx/compare-table').then((mod) => mod.CompareRow),
)
// `Comparison` is not a variant of `CompareTable`: that one is a children-based
// before/after narrative, this one is the redesign's structured attribute table
// that restructures itself below 900px. Both stay registered.
const Comparison = dynamic(() =>
	import('@/components/mdx/comparison').then((mod) => mod.Comparison),
)
const Contrast = dynamic(() =>
	import('@/components/mdx/contrast').then((mod) => mod.Contrast),
)
const CommandCard = dynamic(() =>
	import('@/components/mdx/command-card').then((mod) => mod.CommandCard),
)
const Callout = dynamic(() =>
	import('@/components/mdx/callout').then((mod) => mod.Callout),
)
const Timeline = dynamic(() =>
	import('@/components/mdx/timeline').then((mod) => mod.Timeline),
)
const TimelineItem = dynamic(() =>
	import('@/components/mdx/timeline').then((mod) => mod.TimelineItem),
)
const Quiz = dynamic(() =>
	import('@/components/mdx/quiz').then((mod) => mod.Quiz),
)
const QuizQuestion = dynamic(() =>
	import('@/components/mdx/quiz').then((mod) => mod.QuizQuestion),
)

const getCachedVideoResourceForMdx = cache((id: string) =>
	courseBuilderAdapter.getVideoResource(id),
)

/**
 * Server-resolves the Mux playback ID for a video embedded in MDX body content
 * and passes it to the client player as a prop. Free marketing videos in
 * content bodies then render for everyone, without the client calling the gated
 * `videoResources.get` query. Only resource IDs actually authored into a body
 * (which the viewer is already authorized to see) are resolved — never
 * arbitrary IDs — so paid videos are not exposed. Videos use public Mux
 * playback, so the playback ID is the gate; that is why the query stays locked.
 */
async function MdxEmbeddedVideo({
	resourceId,
	thumbnailTime,
	poster,
}: {
	resourceId: string
	thumbnailTime?: number
	poster?: string
}) {
	if (!resourceId) return null
	let muxPlaybackId: string | undefined
	try {
		const videoResource = await getCachedVideoResourceForMdx(resourceId)
		muxPlaybackId = videoResource?.muxPlaybackId ?? undefined
	} catch (error) {
		// Isolate the failure to this embed instead of failing the whole render.
		await log.error('mdx.video.resolve.error', {
			resourceId,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
	if (!muxPlaybackId) return null
	return (
		<DynamicMDXVideo
			resourceId={resourceId}
			muxPlaybackId={muxPlaybackId}
			thumbnailTime={thumbnailTime}
			poster={poster}
		/>
	)
}

type CompileMDXContext = {
	lessonId?: string
	/**
	 * Server-only proof that the current lesson route passed its purchaser
	 * ability check. The office-hours resolver also requires the cohort to
	 * contain this workshop before it returns any session data.
	 */
	authorizedWorkshopId?: string
	dictionaryAutoLink?: {
		entries: DictionaryEntry[]
		maxLinks?: number
		excludedSlugs?: string[]
	}
	/**
	 * Resolved cross-promo callout line to auto-insert before the 2nd h2 (W1
	 * §2.4). The caller (`PostBody`) decides the variant/copy BEFORE compile and
	 * passes it as a static payload; the remark plugin does zero data fetching.
	 * Because this line depends on external state (the active cohort), it is
	 * part of `compiledMdxCache`'s key — a changed cohort line is a different
	 * entry, never a stale hit.
	 */
	calloutLineAutoInsert?: {
		variant: CalloutIntent
		label: string
		href: string
		linkText: string
	}
}

export { sanitizeMdxSource } from '@/utils/sanitize-mdx-source'

function MDXCompileErrorFallback() {
	return (
		<div className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border p-4 text-sm">
			This lesson content could not be rendered. The team has been notified.
		</div>
	)
}

/**
 * Escape MDX-significant characters (`<`, `{`) that appear outside code spans
 * and fences, so a markdown file that isn't MDX-safe — e.g. a SKILL.md with
 * bare `<actor>` placeholders or `{...}` — renders as literal text instead of
 * throwing at compile time. Code is left verbatim.
 */
export function escapeMdxUnsafe(source: string): string {
	return source
		.split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`)/g)
		.map((segment, index) => {
			// Odd indices are the captured code segments — leave them as-is.
			if (index % 2 === 1) return segment
			return segment.replace(/</g, '&lt;').replace(/\{/g, '&#123;')
		})
		.join('')
}

/**
 * Body-copy anchor. Internal destinations navigate client-side through
 * `next/link`; external ones — and bare `#anchor` jumps, which `Link` would
 * route through the router for nothing — stay plain anchors.
 *
 * `isInternalPath` owns the "is this ours" test — see it for why a leading
 * slash alone is not enough.
 */
function MdxAnchor({
	children,
	href,
	title,
	...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
	if (typeof href === 'string' && isInternalPath(href)) {
		return (
			<Link
				href={href}
				title={title}
				{...props}
				className={cn('ah-prose-a', props.className)}
			>
				{children}
			</Link>
		)
	}

	return (
		<a
			href={href}
			title={title}
			{...props}
			className={cn('ah-prose-a', props.className)}
		>
			{children}
		</a>
	)
}

/**
 * Degraded render path: escape MDX-hostile tokens and compile the result with a
 * minimal markdown pipeline (no CodeHike/Mermaid/components). Used only when the
 * full MDX compile throws, so non-MDX content (github-sourced docs) still
 * renders readably instead of showing an error box.
 *
 * `a` is the one component this path carries. It is exactly the kind of content
 * that reaches here — a github-sourced SKILL.md, which is where the internal
 * links live — so plain `<a>` would cost a full document load on the very
 * articles this change is about. Unlike a minted `TableWrapper`, an anchor
 * override resolves against markdown the compiler already produces.
 */
async function compilePlainMarkdownFallback(
	source: string,
	options: MDXRemoteProps['options'] = {},
) {
	return _compileMDX({
		source: escapeMdxUnsafe(sanitizeMdxSource(source)),
		components: { a: MdxAnchor },
		options: {
			...options,
			mdxOptions: {
				remarkPlugins: [remarkGfm],
				rehypePlugins: [
					rehypeInternalLinks,
					[
						rehypeExternalLinks,
						{ target: '_blank', rel: ['noopener', 'noreferrer'] },
					],
				],
			},
		},
	})
}

function errText(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

type MdxImageProps = React.ImgHTMLAttributes<HTMLImageElement> & {
	width?: number | string
	height?: number | string
}

/**
 * Shared renderer for markdown `img` and the `<Image>` MDX component:
 * configured-cloud Cloudinary URLs go through CldImage (fixed size when
 * width/height are known, fill otherwise); anything else is a plain <img>.
 */
function MdxImage(props: MdxImageProps) {
	const cloudMatch =
		typeof props.src === 'string'
			? props.src.match(/^https?:\/\/res\.cloudinary\.com\/([^/]+)\//)
			: null
	const isConfiguredCloud =
		cloudMatch?.[1] === env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME

	if (isConfiguredCloud) {
		if (props.width && props.height) {
			return (
				<CldImage
					width={props.width}
					height={props.height}
					className={cn('', props.className)}
					{...(props as any)}
				/>
			)
		}
		return (
			<span className="relative block w-full">
				<CldImage
					fill
					sizes="(max-width: 768px) 100vw, 734px"
					className={cn('relative! h-auto! w-full!', props.className)}
					{...(props as any)}
					width={undefined}
					height={undefined}
				/>
			</span>
		)
	}
	return <img {...props} className="" />
}

async function compileMDXInternal(
	source: string,
	components: MDXRemoteProps['components'] = {},
	options: MDXRemoteProps['options'] = {},
	context?: CompileMDXContext,
) {
	const dictionaryAutoLinkPlugin = context?.dictionaryAutoLink
		? createDictionaryAutoLinkRemarkPlugin(context.dictionaryAutoLink)
		: null
	const calloutLineAutoInsertPlugin = context?.calloutLineAutoInsert
		? createCalloutLineAutoInsertRemarkPlugin(context.calloutLineAutoInsert)
		: null
	const dictionaryEntryByHref = new Map(
		context?.dictionaryAutoLink?.entries.map((entry) => [
			`/ai-coding-dictionary/${entry.slug}`,
			entry,
		]) ?? [],
	)

	const outcome = await measureIfSlow({
		event: 'perf.mdx.compile.slow',
		spanName: 'mdx.compile',
		thresholdMs: 150,
		data: {
			sourceLength: source.length,
			hasLessonId: Boolean(context?.lessonId),
		},
		operation: async () =>
			_compileMDX({
				source: sanitizeMdxSource(source),
				components: {
					// Kit-shared implementations for every COMMON_MDX / PAGE_MDX
					// snippet (adds the page-builder blocks this map didn't carry:
					// Spacer, CenteredTitle, Section, BlueSection, Instructor).
					// Spread FIRST so the app's richer local entries below win.
					...createMdxComponents({
						Video: MdxEmbeddedVideo,
						Image: CldImage,
						instructor: {
							name: config.author,
							imageUrl:
								'https://res.cloudinary.com/total-typescript/image/upload/v1741011187/aihero.dev/assets/matt-in-new-studio-square_2x_hutwgm.png',
						},
					}),
					input: (props: React.InputHTMLAttributes<HTMLInputElement>) => {
						// The index is BAKED INTO the compiled tree by
						// `rehypeNumberCheckboxes`, never counted here: this closure is
						// part of the cross-request `compiledMdxCache` entry, so a counter
						// in it would keep incrementing across renders of the cached tree
						// and `MDXCheckbox` persistence would key on drifting indices.
						const index = Number(
							(props as Record<string, unknown>)['data-checkbox-index'],
						)
						if (
							props.type === 'checkbox' &&
							context?.lessonId &&
							Number.isInteger(index)
						) {
							return (
								<DynamicMDXCheckbox
									{...props}
									lessonId={context.lessonId}
									index={index}
								/>
							)
						}
						return <input {...props} />
					},
					Code: (props) => <DynamicCode {...props} />,
					Scrollycoding: (props) => <Scrollycoding {...props} />,
					AISummary,
					Mermaid: (props) => (
						<Mermaid
							{...props}
							className="flex w-full max-w-4xl items-center justify-center rounded-lg border bg-white py-10 dark:bg-transparent"
							config={{
								theme: 'base',
								themeVariables: {
									fontSize: '16px',
								},
							}}
						/>
					),
					Video: ({
						resourceId,
						thumbnailTime,
						poster,
					}: {
						resourceId: string
						thumbnailTime?: number
						poster?: string
					}) => (
						<MdxEmbeddedVideo
							resourceId={resourceId}
							thumbnailTime={thumbnailTime}
							poster={poster}
						/>
					),
					ThemeImage: ({
						urls,
						...props
					}: { urls: { dark: string; light: string } } & CldImageProps) => (
						<ThemeImage urls={urls} {...props} />
					),
					CheckList: ({ children }) => <CheckList>{children}</CheckList>,
					h1: ({ children }) => <Heading level={1}>{children}</Heading>,
					h2: ({ children }) => <Heading level={2}>{children}</Heading>,
					h3: ({ children }) => <Heading level={3}>{children}</Heading>,
					Link: TrackLink,
					AIOnly: ({ children }) => (
						<span className="opacity-50" data-ai-only="">
							{children}
						</span>
					),
					// Live Kit subscriber count (async server component); renders
					// its fallback string when the Kit API is unavailable.
					SubscriberCount: ({
						fallback,
						format,
					}: {
						fallback?: string
						format?: 'rounded' | 'exact'
					}) => <SubscriberCount fallback={fallback} format={format} />,
					SkillsNewsletterCta: ({
						heading,
						subtitle,
					}: {
						heading?: string
						subtitle?: string
					}) => <SkillsNewsletterCta heading={heading} subtitle={subtitle} />,
					SkillsCta: ({
						heading,
						subtitle,
						cta,
					}: {
						heading?: string
						subtitle?: string
						cta?: string
					}) => <SkillsCta heading={heading} subtitle={subtitle} cta={cta} />,
					Button: ({ children, ...props }) => (
						<Button {...props}>{children}</Button>
					),
					// Article prose. These elements used to fall through to
					// @tailwindcss/typography, which meant none of the redesign's
					// prose rules applied anywhere on the site. The rules themselves
					// live in `globals.css` as `.ah-*` classes (see the ARTICLE PROSE
					// block there for why they are CSS and not utility strings);
					// Typography still owns code blocks and tables inside the same
					// wrapper.
					// `cn` merges rather than replaces: remark-gfm tags checkbox
					// lists with `contains-task-list`, and dropping it would put a
					// bullet in front of every checkbox.
					p: (props) => (
						<p {...props} className={cn('ah-prose-p', props.className)} />
					),
					strong: (props) => (
						<strong
							{...props}
							className={cn('ah-prose-strong', props.className)}
						/>
					),
					em: (props) => (
						<em {...props} className={cn('ah-prose-em', props.className)} />
					),
					ul: (props) => (
						<ul {...props} className={cn('ah-bullets', props.className)} />
					),
					ol: (props) => (
						<ol {...props} className={cn('ah-numbers', props.className)} />
					),
					// Fenced code is CodeHike's `<Code>`, so this only ever sees
					// inline spans.
					code: (props) => (
						<code
							{...props}
							className={cn('ah-code-inline', props.className)}
						/>
					),
					blockquote: (props) => (
						<blockquote
							{...props}
							className={cn('ah-prose-quote', props.className)}
						/>
					),
					hr: () => <hr className="ah-prose-hr" />,
					Testimonial: ({
						children,
						authorName,
						authorAvatar,
					}: {
						children: React.ReactNode
						authorName: string
						authorAvatar: string
					}) => (
						<Testimonial authorName={authorName} authorAvatar={authorAvatar}>
							{children}
						</Testimonial>
					),
					Recommendation: ({ children, exerciseId }) => (
						<Recommendation exerciseId={exerciseId}>
							{children}
						</Recommendation>
					),
					TableWrapper: ({ children }) => (
						<TableWrapper>{children}</TableWrapper>
					),
					Spoiler: ({ children }) => <Spoiler>{children}</Spoiler>,
					ProjectVideo: ({ resourceId, exerciseId, recommendation }) => (
						<DynamicProjectVideo
							resourceId={resourceId}
							exerciseId={exerciseId}
							recommendation={recommendation}
						/>
					),
					a: ({ children, href, title, ...props }) => {
						const dictionaryEntry =
							typeof href === 'string'
								? dictionaryEntryByHref.get(href)
								: null

						if (typeof href === 'string' && dictionaryEntry) {
							return (
								<DictionaryHoverLink
									href={href}
									dictionaryTitle={dictionaryEntry.title}
									dictionaryDescription={dictionaryEntry.description}
									{...props}
								>
									{children}
								</DictionaryHoverLink>
							)
						}

						return (
							<MdxAnchor href={href} title={title} {...props}>
								{children}
							</MdxAnchor>
						)
					},
					img: (props) => <MdxImage {...props} />,
					// The editor's media picker inserts `<Image src width height alt />`
					// — same rendering path as markdown images.
					Image: (props: MdxImageProps) => <MdxImage {...props} />,
					CldImage: (props) => <CldImage {...props} />,
					CommitMap: ({ children, packageManager }) => (
						<CommitMap packageManager={packageManager}>{children}</CommitMap>
					),
					Commit: ({ children, id }) => <Commit id={id}>{children}</Commit>,
					CompareTable: ({ children, before, after }) => (
						<CompareTable before={before} after={after}>
							{children}
						</CompareTable>
					),
					CompareRow: ({ before, after }) => (
						<CompareRow before={before} after={after} />
					),
					Comparison: (props: ComparisonProps) => <Comparison {...props} />,
					Contrast: (props: ContrastProps) => <Contrast {...props} />,
					CommandCard: (props: CommandCardProps) => <CommandCard {...props} />,
					Callout: ({ children, icon, className, intent }) => (
						<Callout icon={icon} className={className} intent={intent}>
							{children}
						</Callout>
					),
					PromoCard: (props: PromoCardProps) => <PromoCard {...props} />,
					Timeline: ({ children }) => <Timeline>{children}</Timeline>,
					TimelineItem: ({ children, icon }) => (
						<TimelineItem icon={icon}>{children}</TimelineItem>
					),
					Quiz: ({ children }) => <Quiz>{children}</Quiz>,
					QuizQuestion: (props) => (
						<QuizQuestion {...props} lessonId={context?.lessonId} />
					),
					OfficeHoursSchedule: ({
						sessions,
						cohortId,
						variant,
						showActions,
						timeZone,
						timeZoneLabel,
						className,
					}) => (
						<AuthorizedOfficeHoursSchedule
							sessions={sessions}
							cohortId={cohortId}
							authorizedWorkshopId={context?.authorizedWorkshopId}
							variant={variant}
							showActions={showActions}
							timeZone={timeZone}
							timeZoneLabel={timeZoneLabel}
							className={className}
						/>
					),
					...components,
				},
				options: {
					blockJS: false,
					mdxOptions: {
						remarkPlugins: [
							[
								remarkMermaid,
								{
									debug: process.env.NODE_ENV === 'development',
								},
							],
							remarkGfm,
							...(dictionaryAutoLinkPlugin ? [dictionaryAutoLinkPlugin] : []),
							...(calloutLineAutoInsertPlugin
								? [calloutLineAutoInsertPlugin]
								: []),
							[remarkCodeHike, { components: { code: 'Code' } }],
						],
						rehypePlugins: [
							// Before `rehypeExternalLinks`: an `https://aihero.dev/...`
							// link is ours, and must not be stamped `target="_blank"`.
							rehypeInternalLinks,
							[
								rehypeExternalLinks,
								{ target: '_blank', rel: ['noopener', 'noreferrer'] },
							],
							// Not in the plain-markdown fallback path: that path renders
							// with an empty components map, where a minted TableWrapper
							// element would fail to resolve.
							rehypeAutoTableWrap,
							// Compile-time checkbox numbering; the `input` entry in the
							// components map reads it back. See that entry for why the
							// index cannot be counted at render time.
							rehypeNumberCheckboxes,
						],
						recmaPlugins: [[recmaCodeHike, { components: { code: 'Code' } }]],
					},
					...options,
				},
			})
				.then((value) => ({ ok: true as const, value }))
				.catch((error: unknown) => {
					// Let Next.js handle its own control-flow errors (redirect/
					// notFound/dynamic-server-usage); only genuine MDX compile
					// failures fall back to plain markdown below.
					unstable_rethrow(error)
					return { ok: false as const, error }
				}),
	})

	if (outcome.ok) {
		return outcome.value
	}

	// MDX is stricter than markdown — a bare `<tag>` or `{` (common in a
	// github-sourced SKILL.md, but also a mistyped component) throws. Retry
	// with those tokens escaped and rendered as plain markdown so the content
	// still shows. This is NOT a silent swap: the offending token renders as
	// literal text (e.g. a broken `<Video>` shows as the text `<Video>`) and
	// we warn-log it — strictly better than the "could not be rendered" box.
	await log.warn('mdx.compile.retry-escaped', {
		lessonId: context?.lessonId,
		sourceLength: source.length,
		error: errText(outcome.error),
	})

	try {
		return await compilePlainMarkdownFallback(source, options)
	} catch (fallbackError) {
		await log.error('mdx.compile.error', {
			lessonId: context?.lessonId,
			sourceLength: source.length,
			error: errText(outcome.error),
			fallbackError: errText(fallbackError),
			stack: outcome.error instanceof Error ? outcome.error.stack : undefined,
		})

		return { content: <MDXCompileErrorFallback /> }
	}
}

/**
 * Compiled-MDX cache, shared ACROSS requests for the lifetime of the server
 * instance. The compile (mdx parse + CodeHike/shiki highlighting) is the
 * dominant per-request cost of an article render — heavy code-block pages
 * measured over a second of it — and its output is a pure function of the
 * cache key, so re-running it per request bought nothing.
 *
 * Freshness is BY CONSTRUCTION, not by revalidation: the key hashes the full
 * source plus every piece of context that changes the output (dictionary
 * entries, the resolved cohort callout line, the lesson id that QuizQuestion
 * captures). An edited body — or a changed dictionary or cohort line — is a
 * different key and compiles fresh; the superseded entry simply ages out.
 * This is also what fixes the old request-scoped cache's hazard of serving a
 * callout line resolved for a dead cohort (W1 §2.4): that context now keys
 * the entry instead of bypassing the cache.
 *
 * Reuse across users is safe because nothing per-user exists at compile time:
 * the cached value is an immutable element tree whose components (including
 * data-fetching ones like `SubscriberCount`) are module-level references that
 * React still renders per request.
 */
const compiledMdxCache = new LRUCache<
	string,
	ReturnType<typeof compileMDXInternal>
>({ max: 200 })

function compiledMdxCacheKey(source: string, context?: CompileMDXContext) {
	return createHash('sha256')
		.update(source)
		.update(' ')
		.update(JSON.stringify(context ?? {}))
		.digest('base64')
}

/**
 * Compiles MDX content with support for CodeHike and Mermaid diagrams.
 *
 * Compiles are cached across requests (see `compiledMdxCache`) except when the
 * caller passes custom components or options — functions cannot participate in
 * a serialized cache key, so those calls always compile.
 */
export async function compileMDX(
	source: string,
	components: MDXRemoteProps['components'] = {},
	options: MDXRemoteProps['options'] = {},
	context?: CompileMDXContext,
) {
	const resolvedComponents = components ?? {}
	const resolvedOptions = options ?? {}
	const hasCustomComponents = Object.keys(resolvedComponents).length > 0
	const hasCustomOptions = Object.keys(resolvedOptions).length > 0

	if (hasCustomComponents || hasCustomOptions) {
		return compileMDXInternal(
			source,
			resolvedComponents,
			resolvedOptions,
			context,
		)
	}

	const key = compiledMdxCacheKey(source, context)
	const cached = compiledMdxCache.get(key)
	if (cached) return cached

	const pending = compileMDXInternal(source, {}, {}, context)
	// The PROMISE is cached, not the settled value, so concurrent renders of
	// the same body share one in-flight compile. A rejection evicts itself —
	// anything thrown past the compiler's own fallbacks (Next control-flow
	// errors, which `compileMDXInternal` deliberately rethrows) must not be
	// replayed to later requests. Identity-guarded (`peek`, which does not
	// touch recency): if this entry was LRU-evicted and the key repopulated
	// while the compile was in flight, deleting by key alone would remove the
	// healthy replacement.
	compiledMdxCache.set(key, pending)
	pending.catch(() => {
		if (compiledMdxCache.peek(key) === pending) compiledMdxCache.delete(key)
	})
	return pending
}
