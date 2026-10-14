import styles from './post-purchase-icon.module.css'

/** useAnimations artwork, MIT. See post-purchase-icons.LICENSE. */
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
				<polyline
					points="4 12 9 20 20 4"
					pathLength="1"
					className={styles.checkmark}
				/>
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
 * 20px tick that sits in an eyebrow, where the stroke is heavier so it reads
 * at that size.
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
			className={`bg-accent-fill text-accent-fill-foreground inline-flex shrink-0 items-center justify-center rounded-full ${size === 'sm' ? 'h-5 w-5' : 'h-10 w-10'}`}
		>
			<PostPurchaseIcon
				kind={kind}
				play={play}
				strokeWidth={size === 'sm' ? 3.25 : 2}
				className={
					size === 'sm' ? 'h-3 w-3' : kind === 'ready' ? 'h-8 w-8' : 'h-4 w-4'
				}
			/>
		</span>
	)
}
