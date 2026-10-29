import type * as React from 'react'

type IconProps = React.SVGProps<SVGSVGElement>

/**
 * The two icons Matt uses that this app's lucide release does not ship yet,
 * drawn on lucide's 24px grid so they sit beside the rest unchanged.
 */
function Glyph({ children, ...props }: IconProps) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			strokeLinecap="round"
			strokeLinejoin="round"
			{...props}
		>
			{children}
		</svg>
	)
}

/** lucide `git-pull-request-arrow`: Matt's Git Host. */
export function GitPullRequestArrow(props: IconProps) {
	return (
		<Glyph {...props}>
			<circle cx="5" cy="6" r="3" />
			<path d="M5 9v12" />
			<circle cx="19" cy="18" r="3" />
			<path d="m15 9-3-3 3-3" />
			<path d="M12 6h5a2 2 0 0 1 2 2v7" />
		</Glyph>
	)
}

/** A remote server: a slab with a status light, as Matt draws one. */
export function ServerSlab(props: IconProps) {
	return (
		<Glyph {...props}>
			<rect width="20" height="10" x="2" y="7" rx="2" />
			<path d="M6.5 12h.01" />
		</Glyph>
	)
}
