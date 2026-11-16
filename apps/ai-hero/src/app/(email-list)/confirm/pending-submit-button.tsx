'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * The confirm page's submit button. The form stays a plain HTML POST, so it
 * still works without JavaScript; with it, the button disables on the first
 * submit and says so. Without this, a slow first answer looked like nothing
 * happened, and one reader tapped 23 times in 15 seconds.
 */
export function PendingSubmitButton({
	label,
	pendingLabel,
	className,
}: {
	label: string
	pendingLabel: string
	className?: string
}) {
	const [pending, setPending] = useState(false)
	const ref = useRef<HTMLButtonElement>(null)

	useEffect(() => {
		const form = ref.current?.form
		if (!form) return
		const onSubmit = () => setPending(true)
		// Back from the next page restores this one from the bfcache with the
		// button still disabled: re-enable it.
		const onPageShow = (event: PageTransitionEvent) => {
			if (event.persisted) setPending(false)
		}
		form.addEventListener('submit', onSubmit)
		window.addEventListener('pageshow', onPageShow)
		return () => {
			form.removeEventListener('submit', onSubmit)
			window.removeEventListener('pageshow', onPageShow)
		}
	}, [])

	return (
		<button
			ref={ref}
			className={className}
			type="submit"
			disabled={pending}
			aria-busy={pending || undefined}
		>
			{pending ? pendingLabel : label}
		</button>
	)
}
