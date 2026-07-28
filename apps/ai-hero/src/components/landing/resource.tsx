import * as React from 'react'
import { headers } from 'next/headers'
import { courseBuilderAdapter, db } from '@/db'
import { contentResource } from '@/db/schema'
import { getPricingData } from '@/lib/pricing-query'
import { log } from '@/server/logger'
import { eq, or, sql } from 'drizzle-orm'

import { getPPPDiscountPercent } from '@coursebuilder/core/pricing/parity-coupon'
import { getResourcePath } from '@coursebuilder/utils/resource-paths'

import { DiscountBadge } from './discount-badge'
import { formatPriceUSD, formatStartsAt } from './format'
import { ResourceCard } from './resource-card'
import { ResourceLadderItem } from './resource-ladder-item'
import { ResourceListItem } from './resource-list-item'
import { ResourceRow } from './resource-row'

/**
 * `list` is the dense variant for `TopicsGrid`: title plus a one-line meta,
 * no image. `ladder` is its sibling for `ActivityRung` — same "no artwork"
 * economy, but with a persistent arrow and a format label, because those rows
 * exist to be clicked. The row and card variants carry artwork and a
 * description, which is far too heavy at three-per-column.
 */
export type ResourceVariant = 'row' | 'card' | 'list' | 'ladder'

type InlineProps = {
	title: string
	description?: string
	href: string
	image?: string
	badge?: string
	variant?: ResourceVariant
	slugOrId?: never
}

type ReferenceProps = {
	slugOrId: string
	title?: string
	description?: string
	href?: string
	image?: string
	badge?: string
	variant?: ResourceVariant
}

export type ResourceProps = InlineProps | ReferenceProps

type ResolvedFields = {
	title: string
	description?: string
	href: string
	image?: string
	muxPlaybackId?: string
	thumbnailTime?: number
	type: string
	subType?: string
	productId?: string
	productType?: string
	startsAt?: string
	timezone?: string
	lessonCount?: number
	/** Video runtime in seconds, stamped onto the post by `updatePost`. */
	durationSeconds?: number
}

const SHINE_TYPES = new Set(['cohort', 'workshop', 'tutorial'])
const PPP_INELIGIBLE_PRODUCT_TYPES = new Set([
	'cohort',
	'cohort-archive',
	'live',
])

async function getPPPPercentForRequest(): Promise<number> {
	try {
		const countryCode =
			(await headers()).get('x-vercel-ip-country') ||
			process.env.DEFAULT_COUNTRY ||
			'US'
		return getPPPDiscountPercent(countryCode)
	} catch {
		return 0
	}
}

function readString(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === 'string' && v.length > 0 ? v : undefined
}

function readNumber(obj: unknown, key: string): number | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	return typeof v === 'number' ? v : undefined
}

function readImageUrl(obj: unknown, key: string): string | undefined {
	if (!obj || typeof obj !== 'object') return undefined
	const v = (obj as Record<string, unknown>)[key]
	if (typeof v === 'string' && v.length > 0) return v
	if (v && typeof v === 'object' && 'url' in v) {
		const url = (v as Record<string, unknown>).url
		if (typeof url === 'string' && url.length > 0) return url
	}
	return undefined
}

function muxThumbnailUrl(playbackId: string, thumbnailTime?: number) {
	const time = typeof thumbnailTime === 'number' ? `&time=${thumbnailTime}` : ''
	return `https://image.mux.com/${playbackId}/thumbnail.jpg?width=720&height=405&fit_mode=smartcrop${time}`
}

const YOUTUBE_ID_PATTERNS = [
	/youtube\.com\/watch\?v=([\w-]{11})/,
	/youtu\.be\/([\w-]{11})/,
	/youtube\.com\/embed\/([\w-]{11})/,
	/youtube\.com\/shorts\/([\w-]{11})/,
]

function youtubeVideoId(url: string): string | null {
	for (const pattern of YOUTUBE_ID_PATTERNS) {
		const match = url.match(pattern)
		if (match?.[1]) return match[1]
	}
	return null
}

function youtubeThumbnailUrl(url: string): string | null {
	const id = youtubeVideoId(url)
	if (!id) return null
	const youtubeThumb = `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`
	const cloud = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME
	if (!cloud) return youtubeThumb
	return `https://res.cloudinary.com/${cloud}/image/fetch/c_fill,w_720,h_405,q_auto,f_auto/${youtubeThumb}`
}

function resolveImage(image: string | undefined): string | undefined {
	if (!image) return undefined
	return youtubeThumbnailUrl(image) ?? image
}

function effectiveType(resource: { type: string; fields: unknown }): string {
	if (resource.type === 'list') {
		const subType = readString(resource.fields, 'type')
		if (subType === 'tutorial') return 'tutorial'
	}
	return resource.type
}

async function resolveReference(
	slugOrId: string,
): Promise<ResolvedFields | null> {
	try {
		const resource = await db.query.contentResource.findFirst({
			where: or(
				eq(sql`JSON_EXTRACT (${contentResource.fields}, "$.slug")`, slugOrId),
				eq(contentResource.id, slugOrId),
			),
			with: {
				resources: {
					with: { resource: true },
				},
				resourceProducts: { with: { product: true } },
			},
		})
		if (!resource) {
			await log.warn('draft.resource.missing', { slugOrId })
			return null
		}
		const title = readString(resource.fields, 'title')
		const slug = readString(resource.fields, 'slug')
		if (!title || !slug) {
			await log.warn('draft.resource.malformed', {
				slugOrId,
				type: resource.type,
			})
			return null
		}
		const description =
			readString(resource.fields, 'description') ||
			readString(resource.fields, 'summary')

		let image =
			readImageUrl(resource.fields, 'image') ||
			readImageUrl(resource.fields, 'coverImage')

		let muxPlaybackId: string | undefined
		const thumbnailTime = readNumber(resource.fields, 'thumbnailTime')

		// `updatePost` stamps the mux runtime onto the post itself
		// (`posts-query.ts` → `getVideoDuration`), so the post's own field is the
		// first place to look; the joined videoResource carries it too for rows
		// written before that stamp existed.
		let durationSeconds = readNumber(resource.fields, 'duration')

		if (resource.type === 'post') {
			const videoResource = resource.resources?.find(
				(r) => r.resource?.type === 'videoResource',
			)?.resource
			muxPlaybackId = videoResource
				? readString(videoResource.fields, 'muxPlaybackId')
				: undefined
			if (!durationSeconds && videoResource) {
				durationSeconds = readNumber(videoResource.fields, 'duration')
			}
			if (!image && muxPlaybackId) {
				image = muxThumbnailUrl(muxPlaybackId, thumbnailTime)
			}
		}

		if (!image) {
			const youtubeSource =
				readString(resource.fields, 'youtubeUrl') ||
				readString(resource.fields, 'youtube')
			if (youtubeSource) {
				image = youtubeThumbnailUrl(youtubeSource) ?? undefined
			}
		}

		const type = effectiveType(resource)
		const product = resource.resourceProducts?.[0]?.product
		const lessonCount = resource.resources?.length

		return {
			title,
			description,
			href: getResourcePath(type, slug, 'view'),
			image: resolveImage(image),
			muxPlaybackId,
			thumbnailTime,
			type,
			subType: readString(resource.fields, 'type'),
			productId: product?.id,
			productType: product?.type ?? undefined,
			startsAt: readString(resource.fields, 'startsAt'),
			timezone: readString(resource.fields, 'timezone'),
			lessonCount,
			durationSeconds,
		}
	} catch (error) {
		await log.error('draft.resource.lookup.error', {
			slugOrId,
			error: error instanceof Error ? error.message : String(error),
		})
		return null
	}
}

export async function Resource(props: ResourceProps) {
	const variant = props.variant ?? 'row'

	let resolved: ResolvedFields | null = null
	if (props.slugOrId) {
		resolved = await resolveReference(props.slugOrId)
		if (!resolved && !props.title) return null
	}

	const title = props.title ?? resolved?.title
	const href = props.href ?? resolved?.href
	if (!title || !href) return null

	const description = props.description ?? resolved?.description
	const image =
		resolveImage(props.image) ??
		resolved?.image ??
		youtubeThumbnailUrl(href) ??
		undefined

	if (variant === 'ladder') {
		return (
			<ResourceLadderItem
				title={title}
				href={href}
				isVideo={Boolean(resolved?.muxPlaybackId) || Boolean(youtubeThumbnailUrl(href))}
			/>
		)
	}

	if (variant === 'list') {
		return (
			<ResourceListItem
				title={title}
				href={href}
				type={resolved?.type}
				lessonCount={resolved?.lessonCount}
			/>
		)
	}

	if (variant === 'card') {
		const isVideo = Boolean(
			resolved?.muxPlaybackId || youtubeThumbnailUrl(href),
		)
		return (
			<ResourceCard
				title={title}
				href={href}
				image={image}
				muxPlaybackId={resolved?.muxPlaybackId}
				thumbnailTime={resolved?.thumbnailTime}
				formatLabel={buildFormatLabel(isVideo, resolved?.durationSeconds)}
			/>
		)
	}

	const isShineType = resolved && SHINE_TYPES.has(resolved.type)

	if (!isShineType) {
		return (
			<ResourceRow
				title={title}
				description={description}
				href={href}
				badge={props.badge}
				image={image}
			/>
		)
	}

	const productType = resolved?.productType
	const isPPPEligible =
		Boolean(productType) &&
		!PPP_INELIGIBLE_PRODUCT_TYPES.has(productType as string)

	const [pricingData, couponResult, pppPercent] = await Promise.all([
		resolved?.productId
			? getPricingData({ productId: resolved.productId })
			: Promise.resolve(null),
		resolved?.productId
			? courseBuilderAdapter.getDefaultCoupon([resolved.productId])
			: Promise.resolve(null),
		isPPPEligible ? getPPPPercentForRequest() : Promise.resolve(0),
	])

	const formattedPrice = pricingData?.formattedPrice ?? null
	const defaultCoupon = couponResult?.defaultCoupon ?? null

	const typeLabel = buildTypeLabel(resolved!)
	const fallbackPlaceholder = capitalize(resolved!.type)

	const meta =
		formattedPrice && formattedPrice.unitPrice ? (
			<PriceLine
				original={formattedPrice.unitPrice}
				calculated={formattedPrice.calculatedPrice}
				pppPercent={pppPercent}
			/>
		) : null

	const badge: React.ReactNode = props.badge ? (
		<EditorialBadge>{props.badge}</EditorialBadge>
	) : defaultCoupon ? (
		<DiscountBadge
			percentageOff={Math.round(Number(defaultCoupon.percentageDiscount) * 100)}
			expires={defaultCoupon.expires ?? null}
		/>
	) : null

	return (
		<ResourceRow
			title={title}
			description={description}
			href={href}
			image={image}
			typeLabel={typeLabel}
			badge={badge}
			meta={meta}
			fallbackPlaceholder={fallbackPlaceholder}
		/>
	)
}

/**
 * A posts-grid card's meta line (`Home Page.dc.html` § POSTS): "Video · 12 min",
 * "Video · 9 min", "Article".
 *
 * The runtime is appended only when the resource actually has one — a video
 * whose mux duration has not been stamped yet falls back to the bare format
 * label rather than to a number nobody measured. Articles carry no figure at
 * all, which is the prototype's own rule: all three of its article cards read
 * just "Article", and a reading-time estimate next to a real video runtime
 * claims a precision it does not have.
 */
function buildFormatLabel(
	isVideo: boolean,
	durationSeconds?: number,
): string {
	if (!isVideo) return 'Article'
	if (!durationSeconds || durationSeconds <= 0) return 'Video'
	return `Video · ${Math.max(1, Math.round(durationSeconds / 60))} min`
}

function buildTypeLabel(resolved: ResolvedFields): string {
	const type = resolved.type
	if (type === 'cohort') {
		const tz = resolved.timezone ?? 'America/Los_Angeles'
		if (resolved.startsAt) {
			return `Cohort · Starts ${formatStartsAt(new Date(resolved.startsAt), tz)}`
		}
		return 'Cohort'
	}
	if (type === 'workshop' || type === 'tutorial') {
		// Lesson count intentionally hidden for now — re-enable by returning
		// `${lessons} ${lessons === 1 ? 'lesson' : 'lessons'}` when lessons > 0.
		return ''
	}
	return capitalize(type)
}

function capitalize(s: string): string {
	if (!s) return s
	return s[0]!.toUpperCase() + s.slice(1)
}

function PriceLine({
	original,
	calculated,
	pppPercent,
}: {
	original: number
	calculated: number
	pppPercent?: number
}) {
	const isDiscounted = calculated < original
	const pppOff = pppPercent && pppPercent > 0 ? Math.round(pppPercent * 100) : 0
	return (
		<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono">
			<div className="flex items-baseline gap-2">
				<span className="text-foreground text-base font-semibold">
					{formatPriceUSD(Math.floor(calculated))}
				</span>
				{isDiscounted && (
					<span className="text-foreground/50 text-sm line-through">
						{formatPriceUSD(Math.floor(original))}
					</span>
				)}
			</div>
			{pppOff > 0 && (
				<span className="border-foreground/20 text-foreground/70 dark:border-amber-300/40 dark:text-amber-200 inline-flex items-center rounded-[4px] border px-2 py-0.5 text-xs font-semibold uppercase tracking-wider">
					PPP eligible · save {pppOff}%
				</span>
			)}
		</div>
	)
}

function EditorialBadge({ children }: { children: React.ReactNode }) {
	return (
		<span className="bg-foreground text-background inline-flex w-fit items-center rounded-[4px] px-2.5 py-1 font-mono text-xs font-semibold uppercase tracking-wider">
			{children}
		</span>
	)
}

/**
 * The posts grid (`Home Page.dc.html` § POSTS).
 *
 * Gapped cards, not a hairline grid. Every card here already carries a piece
 * of artwork with its own hard edge, so cells and rules drew a second frame
 * around a thing that was already framed — six boxes inside six boxes. The
 * gap does the separating and the thumbnails do the structure.
 *
 * No fillers either: with nothing to draw a line through, a short last row
 * needs no padding out.
 *
 * Opts out of the landing body's automatic separator (`[&>*+*]:border-t` on
 * the `<article>` in `landing-body.tsx`). That rule assumes every top-level
 * MDX block is a section, but this grid and the `SectionHeader` above it are
 * two blocks making ONE section — so the rule drew a hairline between a
 * heading and the cards it introduces. `!` because the parent's arbitrary
 * variant outscores a plain utility here.
 */
export function ResourceGrid({ children }: { children: React.ReactNode }) {
	return (
		<div className="mt-0! grid w-full grid-cols-1 gap-5 border-t-0! px-8 pb-14 sm:grid-cols-2 sm:px-11 sm:pb-16 lg:grid-cols-3">
			{children}
		</div>
	)
}
