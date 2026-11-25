'use client'

import type { ComponentPropsWithRef } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

type Props = Omit<ComponentPropsWithRef<typeof Link>, 'href'> & {
	href: string
}

/** Cohort sales routes prefetch only after the reader points at or focuses the link. */
export function CohortIntentLink(props: Props) {
	if (props.href.startsWith('/cohorts/')) return <IntentLink {...props} />
	if (props.href.startsWith('/s/')) return <Link {...props} prefetch={false} />
	return <Link {...props} />
}

function IntentLink({ href, onPointerEnter, onFocus, ...props }: Props) {
	const router = useRouter()
	return (
		<Link
			{...props}
			href={href}
			prefetch={false}
			onPointerEnter={(event) => {
				onPointerEnter?.(event)
				if (!event.defaultPrevented) router.prefetch(href)
			}}
			onFocus={(event) => {
				onFocus?.(event)
				if (!event.defaultPrevented) router.prefetch(href)
			}}
		/>
	)
}
