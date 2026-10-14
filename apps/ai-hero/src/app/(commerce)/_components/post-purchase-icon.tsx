import styles from './post-purchase-icon.module.css'

/** The one tick on these screens: the badge and every finished step draw it. */
export const CHECK_PATH = 'M20 6 9 17l-5-5'

/** Mail from useAnimations, MIT. See post-purchase-icons.LICENSE. */
export function PostPurchaseIcon({
	kind,
	className = 'h-6 w-6',
	play = true,
	strokeWidth = 2,
}: {
	kind: 'ready' | 'email'
	className?: string
	play?: boolean
	strokeWidth?: number
}) {
	return (
		<svg
			aria-hidden="true"
			focusable="false"
			data-purchase-icon={kind}
			data-play={play ? 'once' : 'static'}
			width="24"
			height="24"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={strokeWidth}
			strokeLinecap="round"
			strokeLinejoin="round"
			className={`${className} shrink-0`}
		>
			{kind === 'ready' ? (
				<path d={CHECK_PATH} pathLength="1" className={styles.checkmark} />
			) : (
				<g className={styles.mail}>
					<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
					<polyline points="22,6 12,13 2,6" />
				</g>
			)}
		</svg>
	)
}

/**
 * The accent badge. `md` is the 40px badge a next step leads with; `sm` is the
 * 20px tick that sits in an eyebrow, drawn at the stepper's size and weight so
 * the two ticks match. When it plays, the disc grows in and then the glyph draws.
 */
export function PostPurchaseIconBadge({
	kind,
	play = true,
	size = 'md',
}: {
	kind: 'ready' | 'email'
	play?: boolean
	size?: 'sm' | 'md'
}) {
	return (
		<span
			aria-hidden="true"
			data-purchase-badge={kind}
			data-play={play ? 'once' : 'static'}
			className={`${styles.badge} bg-accent-fill text-accent-fill-foreground inline-flex shrink-0 items-center justify-center rounded-full ${size === 'sm' ? 'h-5 w-5' : 'h-10 w-10'}`}
		>
			<PostPurchaseIcon
				kind={kind}
				play={play}
				strokeWidth={size === 'sm' ? 2.75 : 2}
				className={
					size === 'sm' ? 'h-3.5 w-3.5' : kind === 'ready' ? 'h-5 w-5' : 'h-4 w-4'
				}
			/>
		</span>
	)
}
