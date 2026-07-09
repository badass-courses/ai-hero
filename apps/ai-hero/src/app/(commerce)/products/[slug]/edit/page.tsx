import * as React from 'react'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import LayoutClient from '@/components/layout-client'
import { getProduct } from '@/lib/products-query'
import { getServerAuthSession } from '@/server/auth'

import { EditProductClient } from './edit-product-client'

export const dynamic = 'force-dynamic'

const toIso = (value: unknown) =>
	value instanceof Date ? value.toISOString() : value

type Props = {
	params: Promise<{ slug: string }>
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}

const firstParam = (value: string | string[] | undefined) =>
	Array.isArray(value) ? value[0] : value

export default async function ProductEditPage(props: Props) {
	const params = await props.params
	const searchParams = await props.searchParams
	await headers()
	const { ability } = await getServerAuthSession()
	const product = await getProduct(params.slug)

	if (!product || !ability.can('create', 'Content')) {
		notFound()
	}

	// Serialize Date instances before crossing the RSC boundary (toIso pattern
	// from the post edit page):
	// - top-level `createdAt` coerces back via `z.coerce.date()`.
	// - `price.createdAt` is a STRICT `z.date()` in priceSchema, so an ISO
	//   string would fail the editor's zodResolver — null it instead
	//   (`updateProduct` reads only `price.unitAmount` from the input).
	// - `resources` join rows (nested Dates throughout) aren't used by the
	//   editor — the Resources surface loads fresh via `listProductResources`
	//   — so drop them at the boundary.
	const clientProduct = {
		...product,
		createdAt: toIso(product.createdAt),
		price: product.price ? { ...product.price, createdAt: null } : null,
		resources: [],
	} as typeof product

	return (
		<LayoutClient withFooter={false}>
			<EditProductClient
				key={product.fields.slug}
				product={clientProduct}
				// Seed the editor's tab/panel from the URL server-side so SSR
				// renders the same tab the client will (no hydration mismatch).
				initialTab={firstParam(searchParams.tab)}
				initialPanel={firstParam(searchParams.panel)}
			/>
		</LayoutClient>
	)
}
