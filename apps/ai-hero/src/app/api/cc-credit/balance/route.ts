import { NextResponse } from 'next/server'
import { getServerAuthSession } from '@/server/auth'
import {
	creditEnabled,
	creditStore,
	signedInOrganizationScopes,
} from '@/lib/cc-credit/runtime'
import { readCreditBalance } from '@/lib/cc-credit/service'

export const dynamic = 'force-dynamic'
export const revalidate = 0
const headers = { 'Cache-Control': 'private, no-store', Vary: 'Cookie' }

/** No request-supplied user/org ids. Never put these balances in a static page. */
export async function GET() {
	if (!creditEnabled()) return new NextResponse(null, { status: 204, headers })
	const { session } = await getServerAuthSession()
	if (!session?.user?.id)
		return new NextResponse(null, { status: 401, headers })
	try {
		const scopes = await signedInOrganizationScopes(session.user.id)
		let seats = 0
		let amountCents = 0
		for (const scope of scopes) {
			const balance = await readCreditBalance(creditStore, scope)
			seats += balance.seats
			amountCents += balance.amountCents
		}
		if (!Number.isSafeInteger(seats) || !Number.isSafeInteger(amountCents))
			throw new Error('balance_out_of_range')
		return NextResponse.json(
			{ seats, amountCents, currency: 'usd' },
			{ headers },
		)
	} catch {
		// An unavailable ledger is not a zero balance or an offer of credit.
		return NextResponse.json({ state: 'unavailable' }, { status: 503, headers })
	}
}
