import type { Metadata } from 'next'
import LayoutClient from '@/components/layout-client'
import { TYPE } from '@/components/landing/type'
import { TeamInvoiceConfirm } from '@/components/team-invoice/team-invoice-confirm'
import { courseBuilderAdapter } from '@/db'
import { teamInvoiceServerDeps } from '@/lib/team-invoice/team-invoice-server'

import { cn } from '@coursebuilder/ui/utils/cn'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
	title: 'Confirm your team invoice',
	robots: { index: false, follow: false },
}

const TERMS = { due_on_receipt: 'Due on receipt', net_30: 'Net 30' } as const

/**
 * Where the confirm email lands. Reading the page changes nothing; the
 * button's POST creates and sends the invoice. A mail scanner that opens the
 * link only ever sees this summary.
 */
export default async function ConfirmTeamInvoicePage(props: {
	params: Promise<{ token: string }>
}) {
	const { token } = await props.params
	const pending = await teamInvoiceServerDeps().pending.get(token)
	const product = pending
		? await courseBuilderAdapter.getProduct(pending.request.productId)
		: null

	return (
		<LayoutClient withContainer>
			<main className="container flex min-h-[calc(100vh-var(--nav-height))] flex-col px-5">
				<div className="mx-auto flex w-full max-w-xl grow flex-col gap-8 border-x px-6 py-16">
					<h1 className={cn(TYPE.subhead)}>Confirm your team invoice</h1>
					{pending ? (
						<>
							<dl className={cn(TYPE.meta, 'grid grid-cols-[auto_1fr] gap-x-6 gap-y-2')}>
								<dt className="font-semibold">Product</dt>
								<dd>{product?.name ?? pending.request.productId}</dd>
								<dt className="font-semibold">Seats</dt>
								<dd>{pending.request.seats}</dd>
								<dt className="font-semibold">Company</dt>
								<dd>{pending.request.companyName}</dd>
								<dt className="font-semibold">Billing email</dt>
								<dd>{pending.request.billingEmail}</dd>
								<dt className="font-semibold">Terms</dt>
								<dd>{TERMS[pending.request.terms]}</dd>
								{pending.request.poNumber ? (
									<>
										<dt className="font-semibold">PO number</dt>
										<dd>{pending.request.poNumber}</dd>
									</>
								) : null}
							</dl>
							<TeamInvoiceConfirm token={token} />
						</>
					) : (
						<p className={cn(TYPE.meta)}>
							This link has expired or was already used. Start again from
							the team page, or contact us.
						</p>
					)}
				</div>
			</main>
		</LayoutClient>
	)
}
