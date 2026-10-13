import styles from './post-purchase-icon.module.css'

/** useAnimations artwork, MIT. See post-purchase-icons.LICENSE. */
export function PostPurchaseIcon({
	kind,
	className = 'h-6 w-6',
	play = true,
}: {
	kind: 'ready' | 'email'
	className?: string
	play?: boolean
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
			strokeWidth="2"
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

/** Shared 40px accent badge; the ready glyph has a larger, evenly padded frame. */
export function PostPurchaseIconBadge({
	kind,
	play = true,
}: {
	kind: 'ready' | 'email'
	play?: boolean
}) {
	return (
		<span
			aria-hidden="true"
			data-purchase-badge={kind}
			className="bg-accent-fill text-accent-fill-foreground inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
		>
			<PostPurchaseIcon
				kind={kind}
				play={play}
				className={kind === 'ready' ? 'h-8 w-8' : 'h-4 w-4'}
			/>
		</span>
	)
}
