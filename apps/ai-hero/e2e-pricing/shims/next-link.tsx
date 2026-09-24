import * as React from 'react'

export default function Link({
	href,
	...props
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
	return <a href={href} {...props} />
}
