/** Minimal projection of the commerce tables, checked against @/db/schema.
 * status/totalAmount allow NULL here only to exercise defensive schema-drift cases;
 * the production Drizzle columns are NOT NULL. No permanent application DB is used.
 */
export const PROMO_FIXTURE_TABLES = {
	AI_Purchase: {
		id: 'varchar(191)',
		productId: 'varchar(191)',
		createdAt: 'timestamp(3)',
		status: 'varchar(191)',
		totalAmount: 'decimal(65,30)',
		couponId: 'varchar(191)',
		redeemedBulkCouponId: 'varchar(191)',
		bulkCouponId: 'varchar(191)',
	},
	AI_Coupon: {
		id: 'varchar(191)',
		fields: 'json',
		merchantCouponId: 'varchar(191)',
	},
	AI_MerchantCoupon: { id: 'varchar(191)', type: 'varchar(191)' },
} as const

export const promoFixtureDdl = Object.entries(PROMO_FIXTURE_TABLES).map(
	([table, columns]) =>
		`CREATE TABLE \`${table}\` (${Object.entries(columns)
			.map(
				([column, type]) =>
					`\`${column}\` ${type}${column === 'id' ? ' PRIMARY KEY' : ''}`,
			)
			.join(', ')})`,
)
