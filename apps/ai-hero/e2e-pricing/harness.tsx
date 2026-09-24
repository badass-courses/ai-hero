// Mounts the production workshop CTAs (sidebar card + inline MDX button) with
// their real tRPC client, XState pricing actor and checkout form. The spec
// answers every network request from an in-memory Playwright route fixture, so
// this page needs no database, session, coupon row or Stripe account.
import * as React from 'react'
import {
	WorkshopInlineBuyButton,
	WorkshopPricingClient,
} from '@/app/(content)/workshops/_components/workshop-pricing'
import { api } from '@/trpc/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { httpLink } from '@trpc/client'
import { createRoot } from 'react-dom/client'
import SuperJSON from 'superjson'

import type { Product } from '@coursebuilder/core/schemas'

import { fixtureProduct } from './fixture-data'

const product = fixtureProduct as unknown as Product

const pricingDataLoader = Promise.resolve({
	formattedPrice: null,
	purchaseToUpgrade: null,
	quantityAvailable: -1,
})

function Fixture() {
	const [queryClient] = React.useState(
		() => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
	)
	const [trpcClient] = React.useState(() =>
		api.createClient({
			links: [httpLink({ url: '/api/trpc', transformer: SuperJSON })],
		}),
	)
	return (
		<QueryClientProvider client={queryClient}>
			<api.Provider client={trpcClient} queryClient={queryClient}>
				<main>
					<section data-testid="sidebar-cta">
						<WorkshopPricingClient
							product={product}
							quantityAvailable={-1}
							availableBonuses={[]}
							pricingDataLoader={pricingDataLoader}
							products={[product]}
						/>
					</section>
					<section data-testid="inline-cta">
						<WorkshopInlineBuyButton
							pricingProps={{ products: [product] } as never}
							pricingDataLoader={pricingDataLoader}
							resource={{ fields: { slug: 'crash-course' } } as never}
							resourceType="workshop"
						/>
					</section>
				</main>
			</api.Provider>
		</QueryClientProvider>
	)
}

createRoot(document.getElementById('root')!).render(<Fixture />)
