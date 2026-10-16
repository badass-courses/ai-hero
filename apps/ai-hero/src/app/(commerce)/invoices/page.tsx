import Link from 'next/link'
import { redirect } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { getInvoicePurchasesForUser } from '@/lib/invoice-access'
import { invoiceListView } from '@/lib/invoice-access-rules'
import { invoiceEditPath } from '@/lib/invoice-paths'
import { getServerAuthSession } from '@/server/auth'

import { InvoiceCard } from '@coursebuilder/commerce-next/invoices/invoice-card'
import { Button } from '@coursebuilder/ui'

const Invoices = async () => {
	const { session } = await getServerAuthSession()
	if (!session?.user?.id) redirect('/login?callbackUrl=%2Finvoices')

	const purchases = await getInvoicePurchasesForUser(session?.user?.id)
	const view = invoiceListView(purchases)
	return (
		<LayoutClient withContainer>
			<main className="container flex min-h-[calc(100vh-var(--nav-height))] flex-col px-5">
				<div className="max-w-(--breakpoint-md) mx-auto flex h-full w-full grow flex-col items-center border-x py-16">
					<h1 className="font-heading mb-16 text-3xl font-black">
						{view.heading}
					</h1>
					{view.emptyMessage ? (
						<p className="text-muted-foreground max-w-prose px-5 text-center">
							{view.emptyMessage}
						</p>
					) : (
						<ul className="divide-border flex w-full flex-col divide-y border-t">
							{view.entries.map(({ row, merchantChargeId, refunded }) => (
								<li key={merchantChargeId}>
									<InvoiceCard className="rounded-none border-0" purchase={row}>
										{refunded && (
											<p className="mb-2 text-sm font-medium text-red-600">
												Refunded
											</p>
										)}
										<Button asChild variant="secondary" size="sm">
											<Link href={invoiceEditPath(merchantChargeId)}>
												Edit invoice details
											</Link>
										</Button>
									</InvoiceCard>
								</li>
							))}
						</ul>
					)}
				</div>
			</main>
		</LayoutClient>
	)
}

export default Invoices
