import { db } from '@/db'
import * as schema from '@/db/schema'

import { createDatabaseProvider } from '@coursebuilder/analytics/providers/database'

const provider = createDatabaseProvider(db, schema)

export const {
	getRevenueSummary,
	getRevenueByDay,
	getPreviousPeriodRevenueByDay,
	getRevenueByProduct,
	getRevenueByCountry,
	getRecentPurchases,
	getAttributionSummary,
	getShortlinkPerformance,
	getRevenueBySource,
	getConversionFunnel,
	getCommerceLaneSummary,
	getAttributedRevenueSummary,
	getContentPurchaseCorrelation,
	getCheckoutAttributionReceipt,
	getCheckoutSurveyFallbackReport,
	getValuePathSummary,
} = provider

export default provider
