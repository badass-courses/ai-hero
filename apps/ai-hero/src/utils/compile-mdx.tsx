import { cache } from 'react'
import dynamic from 'next/dynamic'
import { SkillsCta } from '@/app/(content)/skills/_components/skills-cta'
import { SkillsNewsletterCta } from '@/app/(content)/skills/_components/skills-newsletter-cta'
import {
	CheckList,
	Recommendation,
} from '@/app/admin/pages/_components/page-builder-mdx-components'
import { CldImage, ThemeImage } from '@/components/cld-image'
import { DictionaryHoverLink } from '@/components/dictionary/dictionary-hover-link'
import { Heading } from '@/components/mdx/heading'
import { AISummary, TrackLink } from '@/components/mdx/mdx-components'
import { courseBuilderAdapter } from '@/db'
import { env } from '@/env.mjs'
import type { DictionaryEntry } from '@/lib/ai-coding-dictionary'
import { createDictionaryAutoLinkRemarkPlugin } from '@/lib/dictionary-autolink'
import { log } from '@/server/logger'
import { measureIfSlow } from '@/server/perf'
import { recmaCodeHike, remarkCodeHike } from 'codehike/mdx'
import type { CldImageProps } from 'next-cloudinary'
import {
	compileMDX as _compileMDX,
	type MDXRemoteProps,
} from 'next-mdx-remote/rsc'
import rehypeExternalLinks from 'rehype-external-links'
import remarkGfm from 'remark-gfm'

import { remarkMermaid } from '@coursebuilder/mdx-mermaid'
import { Button } from '@coursebuilder/ui'
import { cn } from '@coursebuilder/ui/utils/cn'

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
const Callout = dynamic(() =>
	import('@/components/mdx/callout').then((mod) => mod.Callout),
)
const Timeline = dynamic(() =>
	import('@/components/mdx/timeline').then((mod) => mod.Timeline),
)
const TimelineItem = dynamic(() =>
	import('@/components/mdx/timeline').then((mod) => mod.TimelineItem),
)
const DynamicOfficeHoursSchedule = dynamic(() =>
	import('@/components/office-hours-schedule').then(
		(mod) => mod.OfficeHoursSchedule,
	),
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
	dictionaryAutoLink?: {
		entries: DictionaryEntry[]
		maxLinks?: number
		excludedSlugs?: string[]
	}
	/**
	 * When true, a failed MDX compile retries as escaped plain markdown instead
	 * of showing the error box. Enable only for content that isn't authored as
	 * MDX (e.g. github-sourced docs); leave off for CMS-authored MDX so real
	 * authoring mistakes still surface.
	 */
	allowPlainMarkdownFallback?: boolean
}

export function sanitizeMdxSource(source: string) {
	return source.replace(/<!--[\s\S]*?-->/g, '')
}

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
 * Degraded render path: escape MDX-hostile tokens and compile the result with a
 * minimal markdown pipeline (no CodeHike/Mermaid/components). Used only when the
 * full MDX compile throws, so non-MDX content (github-sourced docs) still
 * renders readably instead of showing an error box.
 */
async function compilePlainMarkdownFallback(
	source: string,
	options: MDXRemoteProps['options'] = {},
) {
	return _compileMDX({
		source: escapeMdxUnsafe(sanitizeMdxSource(source)),
		components: {},
		options: {
			...options,
			mdxOptions: {
				remarkPlugins: [remarkGfm],
				rehypePlugins: [
					[
						rehypeExternalLinks,
						{ target: '_blank', rel: ['noopener', 'noreferrer'] },
					],
				],
			},
		},
	})
}

async function compileMDXInternal(
	source: string,
	components: MDXRemoteProps['components'] = {},
	options: MDXRemoteProps['options'] = {},
	context?: CompileMDXContext,
) {
	let checkboxIndex = 0
	const dictionaryAutoLinkPlugin = context?.dictionaryAutoLink
		? createDictionaryAutoLinkRemarkPlugin(context.dictionaryAutoLink)
		: null
	const dictionaryEntryByHref = new Map(
		context?.dictionaryAutoLink?.entries.map((entry) => [
			`/ai-coding-dictionary/${entry.slug}`,
			entry,
		]) ?? [],
	)

	try {
		return await measureIfSlow({
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
						input: (props: React.InputHTMLAttributes<HTMLInputElement>) => {
							if (props.type === 'checkbox' && context?.lessonId) {
								const currentIndex = checkboxIndex++
								return (
									<DynamicMDXCheckbox
										{...props}
										lessonId={context.lessonId}
										index={currentIndex}
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
						hr: () => <hr className="bg-stripes my-1 h-2 w-full border-none" />,
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
								<a href={href} title={title} {...props}>
									{children}
								</a>
							)
						},
						img: (props) => {
							const cloudMatch =
								typeof props.src === 'string'
									? props.src.match(
											/^https?:\/\/res\.cloudinary\.com\/([^/]+)\//,
										)
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
											{...props}
										/>
									)
								}
								return (
									<span className="relative block w-full">
										<CldImage
											fill
											sizes="(max-width: 768px) 100vw, 734px"
											className={cn(
												'relative! h-auto! w-full!',
												props.className,
											)}
											{...props}
											width={undefined}
											height={undefined}
										/>
									</span>
								)
							}
							return <img {...props} className="" />
						},
						CldImage: (props) => <CldImage {...props} />,
						CommitMap: ({ children }) => <CommitMap>{children}</CommitMap>,
						Commit: ({ children, id }) => <Commit id={id}>{children}</Commit>,
						CompareTable: ({ children, before, after }) => (
							<CompareTable before={before} after={after}>
								{children}
							</CompareTable>
						),
						CompareRow: ({ before, after }) => (
							<CompareRow before={before} after={after} />
						),
						Callout: ({ children, icon, className }) => (
							<Callout icon={icon} className={className}>
								{children}
							</Callout>
						),
						Timeline: ({ children }) => <Timeline>{children}</Timeline>,
						TimelineItem: ({ children, icon }) => (
							<TimelineItem icon={icon}>{children}</TimelineItem>
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
							<DynamicOfficeHoursSchedule
								sessions={sessions}
								cohortId={cohortId}
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
								[remarkCodeHike, { components: { code: 'Code' } }],
							],
							rehypePlugins: [
								[
									rehypeExternalLinks,
									{ target: '_blank', rel: ['noopener', 'noreferrer'] },
								],
							],
							recmaPlugins: [[recmaCodeHike, { components: { code: 'Code' } }]],
						},
						...options,
					},
				}),
		})
	} catch (error) {
		// Only content flagged as non-MDX (github-sourced docs) degrades to
		// escaped plain markdown. CMS-authored MDX keeps the error box so a real
		// authoring mistake (e.g. a malformed <Component>) stays visible.
		if (context?.allowPlainMarkdownFallback) {
			// MDX is stricter than markdown — a bare `<tag>` or `{` (common in a
			// SKILL.md) throws. Retry with those tokens escaped so it still shows.
			await log.warn('mdx.compile.retry-escaped', {
				lessonId: context?.lessonId,
				sourceLength: source.length,
				error: error instanceof Error ? error.message : String(error),
			})

			try {
				return await compilePlainMarkdownFallback(source, options)
			} catch (fallbackError) {
				await log.error('mdx.compile.error', {
					lessonId: context?.lessonId,
					sourceLength: source.length,
					error: error instanceof Error ? error.message : String(error),
					fallbackError:
						fallbackError instanceof Error
							? fallbackError.message
							: String(fallbackError),
					stack: error instanceof Error ? error.stack : undefined,
				})

				return { content: <MDXCompileErrorFallback /> }
			}
		}

		await log.error('mdx.compile.error', {
			lessonId: context?.lessonId,
			sourceLength: source.length,
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		})

		return { content: <MDXCompileErrorFallback /> }
	}
}

const compileDefaultMDX = cache(async (source: string, lessonId?: string) => {
	return compileMDXInternal(source, {}, {}, { lessonId })
})

/**
 * Compiles MDX content with support for CodeHike and Mermaid diagrams.
 *
 * The default compile path is request-scoped cached, which is the safest form
 * of MDX caching for this app: it avoids cross-user reuse while deduplicating
 * repeated compiles within a single render tree.
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

	if (!hasCustomComponents && !hasCustomOptions) {
		return compileDefaultMDX(source, context?.lessonId)
	}

	return compileMDXInternal(
		source,
		resolvedComponents,
		resolvedOptions,
		context,
	)
}
