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
			className={`${className} shrink-0 text-primary`}
		>
			{kind === 'ready' ? (
				<polyline
					points="4 12 9 17 20 6"
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
