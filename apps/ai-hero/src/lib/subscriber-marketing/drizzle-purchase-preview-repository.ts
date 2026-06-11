import { purchases, products, users } from '@/db/schema'
import { desc, eq, inArray } from 'drizzle-orm'

import type {
	PurchasePreviewProduct,
	PurchasePreviewPurchase,
	PurchasePreviewRepository,
} from './purchase-preview'

type AiHeroReadDatabase = any

export class DrizzlePurchasePreviewRepository implements PurchasePreviewRepository {
	constructor(private readonly database: AiHeroReadDatabase) {}

	async findProductsByIds(
		productIds: string[],
	): Promise<PurchasePreviewProduct[]> {
		if (productIds.length === 0) return []
		const rows = await this.database
			.select({
				id: products.id,
				name: products.name,
			})
			.from(products)
			.where(inArray(products.id, productIds))
		return rows
	}

	async findPurchasesByProductIds(
		productIds: string[],
	): Promise<PurchasePreviewPurchase[]> {
		if (productIds.length === 0) return []
		const rows = await this.database
			.select({
				purchaseId: purchases.id,
				productId: purchases.productId,
				productName: products.name,
				userId: purchases.userId,
				email: users.email,
				createdAt: purchases.createdAt,
				status: purchases.status,
				totalAmount: purchases.totalAmount,
				country: purchases.country,
			})
			.from(purchases)
			.leftJoin(products, eq(purchases.productId, products.id))
			.leftJoin(users, eq(purchases.userId, users.id))
			.where(inArray(purchases.productId, productIds))
			.orderBy(desc(purchases.createdAt))

		return rows.map((row: any) => ({
			purchaseId: row.purchaseId,
			productId: row.productId,
			productName: row.productName ?? 'Unknown product',
			userId: row.userId,
			email: row.email,
			createdAt: toIso(row.createdAt),
			status: row.status,
			totalAmount: Number(row.totalAmount ?? 0),
			country: row.country,
		}))
	}
}

function toIso(value: string | Date) {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString()
}
