import * as React from 'react'
import { CldImage } from '@/components/cld-image'

import { cn } from '@coursebuilder/utils/cn'

/**
 * Max's spot illustrations: one rounded glowing tile per surface, exported as
 * transparent PNGs with the glow baked into the canvas, so the visible tile is
 * roughly 85% of the box and the rest is halo. Size the box, not the tile.
 *
 * Served from the shared Total TypeScript Cloudinary (`aihero.dev/spot-illos/`),
 * same as every other piece of site artwork. The PSD sources live in Dropbox.
 */
const CLOUDINARY = 'https://res.cloudinary.com/total-typescript/image/upload'

export const SPOT_ILLUSTRATIONS = {
	/** Grid, block and sphere. `/open-source`. */
	build: { src: `${CLOUDINARY}/v1789463135/aihero.dev/spot-illos/build.png`, width: 636, height: 630 },
	/** The skills mark. `/skills/subscribe` hero. */
	real: { src: `${CLOUDINARY}/v1789463136/aihero.dev/spot-illos/real.png`, width: 636, height: 630 },
	/** Four heads around a table. The team card on `/courses`. */
	team: { src: `${CLOUDINARY}/v1789463138/aihero.dev/spot-illos/team.png`, width: 636, height: 630 },
	/** The X. The home page's "What do you want to do?" ladder. */
	todo: { src: `${CLOUDINARY}/v1789463139/aihero.dev/spot-illos/todo.png`, width: 630, height: 628 },
	/** The X, portrait. `/learn`'s hero. */
	todoBig: { src: `${CLOUDINARY}/v1789463140/aihero.dev/spot-illos/todo-big.png`, width: 625, height: 951 },
} as const

export type SpotIllustrationName = keyof typeof SPOT_ILLUSTRATIONS

/**
 * Decorative: empty alt and hidden from the tree, because every surface that
 * carries one already says in words what the picture shows.
 */
export function SpotIllustration({
	name,
	className,
	sizes,
}: {
	name: SpotIllustrationName
	/** Sets the rendered box; the image is `h-auto w-full` inside it. */
	className?: string
	/** `next/image` `sizes`, so the srcset picks a width near the rendered one. */
	sizes: string
}) {
	const illo = SPOT_ILLUSTRATIONS[name]
	return (
		<CldImage
			src={illo.src}
			width={illo.width}
			height={illo.height}
			alt=""
			aria-hidden
			sizes={sizes}
			className={cn('pointer-events-none h-auto w-full select-none', className)}
		/>
	)
}
