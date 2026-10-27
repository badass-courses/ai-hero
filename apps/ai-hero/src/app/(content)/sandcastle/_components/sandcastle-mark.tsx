import Image from 'next/image'

import { cn } from '@coursebuilder/ui/utils/cn'

/**
 * The tower tile from the README's wordmark, cropped by Cloudinary out of the
 * same light/dark pair the landing page shows, so the two never drift apart.
 * The tile sits at x 206–353, y 0–146 of the 562×302 asset.
 */
const crop = (variant: 'onlight' | 'ondark') =>
	`https://res.cloudinary.com/total-typescript/image/upload/c_crop,x_206,y_0,w_148,h_148/v1775033787/readme-sandcastle-${variant}_2x.png`

export function SandcastleMark({ className }: { className?: string }) {
	return (
		<>
			<Image
				src={crop('onlight')}
				alt=""
				width={148}
				height={148}
				className={cn('shrink-0 dark:hidden', className)}
			/>
			<Image
				src={crop('ondark')}
				alt=""
				width={148}
				height={148}
				className={cn('hidden shrink-0 dark:block', className)}
			/>
		</>
	)
}

/**
 * The README mark's tower as a one-colour glyph for a nav row: three merlons,
 * a tapered body and an arched door, in the row's own colour.
 */
export function SandcastleGlyph({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 16 16"
			fill="currentColor"
			className={className}
		>
			<path
				fillRule="evenodd"
				d="M3 1.5h2.25v1.75h1.5V1.5h2.5v1.75h1.5V1.5H13v4.25l-1.25 1.5V14.5h-7.5V7.25L3 5.75V1.5Zm3.75 13v-2.75a1.25 1.25 0 0 1 2.5 0v2.75h-2.5Z"
			/>
		</svg>
	)
}
