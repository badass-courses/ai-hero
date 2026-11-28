'use client'

import { useState, type FormEvent } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { BROWSER_COMP_CLAIM } from '@/lib/coupon-batches/namespace'

export function PrivateCompOffer({
	productId,
	path,
	email,
}: {
	productId: string
	path: string
	email?: string | null
}) {
	const router = useRouter()
	const [pending, setPending] = useState(false)
	const [error, setError] = useState(false)
	async function claim(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (pending) return
		const email = new FormData(event.currentTarget).get('email')
		setPending(true)
		setError(false)
		try {
			const response = await fetch('/api/coursebuilder/redeem/coupon', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					couponId: BROWSER_COMP_CLAIM,
					email,
					productIds: [productId],
				}),
			})
			if (response.ok) {
				const result = await response.json()
				if (result.purchase?.id && !result.error) {
					const id = encodeURIComponent(result.purchase.id)
					if (result.redeemingForCurrentUser)
						await fetch('/api/auth/session?update').catch(() => {})
					router.push(
						`${result.redeemingForCurrentUser ? '/welcome' : '/thanks/redeem'}?purchaseId=${id}`,
					)
					return
				}
			}
		} catch {
			// Do not log request or response data from this claim.
		}
		setError(true)
		setPending(false)
	}
	return (
		<section data-private-comp-offer="" className="flex flex-col gap-4 p-5">
			<h2 className="text-xl font-semibold">Complimentary enrollment</h2>
			<p className="text-2xl font-semibold">$0</p>
			<form onSubmit={claim} className="flex flex-col gap-2">
				<label htmlFor="private-comp-email">Email address</label>
				<input
					className="rounded border px-3 py-2"
					id="private-comp-email"
					name="email"
					type="email"
					defaultValue={email ?? ''}
					required
				/>
				<button
					className="bg-primary text-primary-foreground rounded px-4 py-2 font-semibold"
					type="submit"
					disabled={pending}
				>
					{pending ? 'Claiming…' : 'Claim your seat'}
				</button>
			</form>
			{error ? (
				<p role="alert">
					This seat could not be claimed. If you already enrolled, check your
					account.
				</p>
			) : null}
			{!email ? (
				<Link href={`/login?callbackUrl=${encodeURIComponent(path)}`}>
					Sign in
				</Link>
			) : null}
		</section>
	)
}
