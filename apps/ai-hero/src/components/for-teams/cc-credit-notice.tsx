'use client'

import { useEffect, useState } from 'react'
import { useSession } from 'next-auth/react'
import { TYPE } from '@/components/landing/type'
import { cn } from '@coursebuilder/ui/utils/cn'

type Balance = { seats: number; amountCents: number; currency: 'usd' }

/** Private runtime island on static team pages. Never changes checkout. */
export function CcCreditNotice() {
	const { data: session, status } = useSession()
	const userId = status === 'authenticated' ? session?.user?.id : undefined
	const [loaded, setLoaded] = useState<{
		userId: string
		balance: Balance
	} | null>(null)
	useEffect(() => {
		if (!userId) return
		const controller = new AbortController()
		fetch('/api/cc-credit/balance', {
			cache: 'no-store',
			credentials: 'same-origin',
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok || response.status === 204) return
				const balance = (await response.json()) as Balance
				if (
					balance.currency === 'usd' &&
					Number.isSafeInteger(balance.seats) &&
					balance.seats > 0 &&
					Number.isSafeInteger(balance.amountCents) &&
					balance.amountCents > 0 &&
					!controller.signal.aborted
				)
					setLoaded({ userId, balance })
			})
			.catch(() => undefined)
		return () => controller.abort()
	}, [userId])
	if (!loaded || loaded.userId !== userId) return null
	const { seats, amountCents } = loaded.balance
	const amount = new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
	}).format(amountCents / 100)
	return (
		<section
			aria-label="Your team's Crash Course credit"
			className="border-border bg-muted text-foreground border-b"
		>
			<div className="px-[18px] py-12 sm:px-11 md:py-[52px]">
				<p className={cn(TYPE.body, 'max-w-[65ch]')}>
					{seats === 1
						? `Your team has 1 unused Crash Course seat. It's worth ${amount} off one Software Factories for Real Engineers seat. Reply to your invoice email or `
						: `Your team has ${seats} unused Crash Course seats. They're worth ${amount} off the same number of Software Factories for Real Engineers seats. Reply to your invoice email or `}
					<a
						href="mailto:team@aihero.dev"
						className="underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
					>
						contact us
					</a>
					{seats === 1 ? ' to use it.' : ' to use them.'}
				</p>
			</div>
		</section>
	)
}
