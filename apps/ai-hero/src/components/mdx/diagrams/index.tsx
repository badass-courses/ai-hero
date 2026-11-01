import type * as React from 'react'
import { TYPE } from '@/components/landing/type'
import { cn } from '@coursebuilder/ui/utils/cn'

import { boardRedraws } from './boards'
import { chartRedraws } from './charts'
import { flowRedraws } from './flows'
import { graphRedraws } from './graphs'
import { notDrawings } from './not-drawings'
import { slideRedraws } from './slides'
import type { Redraws } from './redraws'

/**
 * Matt's lesson drawings redrawn in code. Lesson bodies arrive from his course
 * source through course sync, so the markdown keeps pointing at his images
 * and the swap happens at render: a resync cannot undo it. An image he
 * re-uploads gets a new id and shows as itself until its entry is updated.
 */
const REDRAWS: Redraws = {
	...flowRedraws,
	...graphRedraws,
	...slideRedraws,
	...boardRedraws,
	...chartRedraws,
}

/** The public id in a Cloudinary delivery URL: the path after the version
    segment, without transformations or a file extension. */
export function publicIdOf(src: unknown): string | null {
	if (typeof src !== 'string') return null
	const match = src.match(
		/\/image\/upload\/(?:.*\/)?v\d+\/([^?#]+?)(?:\.[a-z0-9]+)?(?:[?#]|$)/i,
	)
	return match?.[1] ?? null
}

/**
 * The redrawn version of an image, or null to show the image itself. The
 * image's alt text stays with the redraw for screen readers: the drawing's
 * labels alone don't say what a curve or an arrow means.
 */
export function redrawForImage(
	src: unknown,
	alt?: unknown,
): React.ReactNode | null {
	const id = publicIdOf(src)
	if (!id || !Object.hasOwn(REDRAWS, id)) return null
	const redraw = REDRAWS[id]!
	return (
		<>
			{typeof alt === 'string' && alt.trim() ? (
				<span className="sr-only">{alt}</span>
			) : null}
			{redraw()}
			{/* Matt's drawing, for anyone who wants the hand-drawn version. The
			    figure's bottom margin collapses with the negative top margin,
			    so the link sits just under it. */}
			<a
				href={src as string}
				target="_blank"
				rel="noopener noreferrer"
				aria-label="Open the original drawing"
				className={cn(
					TYPE.metaSm,
					'not-prose text-muted-foreground hover:text-foreground -mt-6 mb-8 ml-auto block w-fit no-underline transition-colors',
				)}
			>
				Original ↗
			</a>
		</>
	)
}

/**
 * The Cloudinary images in a lesson body that still show as themselves: no
 * redraw yet, and not marked as something that stays an image. Each id once,
 * in body order.
 */
export function undrawnImages(body: string): { id: string; url: string }[] {
	const images = new Map<string, string>()
	for (const [url] of body.matchAll(
		/https?:\/\/res\.cloudinary\.com\/[^\s)"'<>]+/g,
	)) {
		const id = publicIdOf(url)
		if (!id || Object.hasOwn(REDRAWS, id) || notDrawings.has(id)) continue
		if (!images.has(id)) images.set(id, url)
	}
	return [...images].map(([id, url]) => ({ id, url }))
}

/** Every redrawn id. */
export const redrawnIds = Object.keys(REDRAWS)

/** Every redrawn id, grouped by the kind of drawing. */
export const redrawnIdsByKind = {
	Flows: Object.keys(flowRedraws),
	Graphs: Object.keys(graphRedraws),
	Slides: Object.keys(slideRedraws),
	Boards: Object.keys(boardRedraws),
	Charts: Object.keys(chartRedraws),
}
