import Link from 'next/link'
import LayoutClient from '@/components/layout-client'
import { courseBuilderAdapter } from '@/db'
import { invoiceEditPath } from '@/lib/invoice-paths'
import { getServerAuthSession } from '@/server/auth'

import { InvoiceCard } from '@coursebuilder/commerce-next/invoices/invoice-card'
import { Purchase } from '@coursebuilder/core/schemas'
import { Button } from '@coursebuilder/ui'

const Invoices = async () => {
	const { session } = await getServerAuthSession()

	const purchases =
		(await courseBuilderAdapter.getPurchasesForUser(session?.user?.id)) || []
	return (
		<LayoutClient withContainer>
			<main className="container flex min-h-[calc(100vh-var(--nav-height))] flex-col px-5">
				<div className="max-w-(--breakpoint-md) mx-auto flex h-full w-full grow flex-col items-center border-x py-16">
					<h1 className="font-heading mb-16 text-3xl font-black">
						{purchases.length > 0 ? 'Your Invoices' : 'No invoices'}
					</h1>
					<ul className="divide-border flex w-full flex-col divide-y border-t">
						{purchases
							.filter((purchase: Purchase) => purchase.merchantChargeId)
							.map((purchase: Purchase | any) => {
								return (
									<li key={purchase.merchantChargeId}>
										<InvoiceCard
											className="rounded-none border-0"
											purchase={purchase}
										>
											<Button asChild variant="secondary" size="sm">
												<Link href={invoiceEditPath(purchase.merchantChargeId)}>
													Edit invoice details
												</Link>
											</Button>
										</InvoiceCard>
									</li>
								)
							})}
					</ul>
				</div>
			</main>
		</LayoutClient>
	)
}

export default Invoices
