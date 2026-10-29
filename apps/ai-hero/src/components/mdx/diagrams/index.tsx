import type * as React from 'react'
import { boardRedraws } from './boards'
import { chartRedraws } from './charts'
import { flowRedraws } from './flows'
import { graphRedraws } from './graphs'
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

/** The redrawn version of an image, or null to show the image itself. */
export function redrawForImage(src: unknown): React.ReactNode | null {
	const id = publicIdOf(src)
	const redraw = id ? REDRAWS[id] : undefined
	return redraw ? redraw() : null
}

/** Every redrawn id, for the review page. */
export const redrawnIds = Object.keys(REDRAWS)
