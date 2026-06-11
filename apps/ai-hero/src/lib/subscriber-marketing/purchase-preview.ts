import { createHash } from 'node:crypto'

export type QuickQuestionIdentityRow = {
	email: string
	rowId?: string
}

export type PurchasePreviewProduct = {
	id: string
	name: string
}

export type PurchasePreviewPurchase = {
	purchaseId: string
	productId: string
	productName: string
	userId?: string | null
	email?: string | null
	createdAt: string
	status: string
	totalAmount: number
	country?: string | null
}

export type PurchasePreviewRepository = {
	findProductsByIds(productIds: string[]): Promise<PurchasePreviewProduct[]>
	findPurchasesByProductIds(
		productIds: string[],
	): Promise<PurchasePreviewPurchase[]>
}

export type PurchasePreviewResult = {
	mode: 'read-only-preview'
	privacy: {
		rawEmailsIncluded: false
		rawPayloadIncluded: false
	}
	quickQuestion: {
		rows: number
		rowsWithEmail: number
		uniqueEmails: number
	}
	products: Array<{
		productId: string
		productName: string
		totalPurchases: number
		matchedPurchases: number
		matchedUniqueEmails: number
		byStatus: Record<string, { count: number; gross: number }>
		matchedByStatus: Record<string, { count: number; gross: number }>
		matchedExamples: Array<{
			emailHash: string
			domain: string
			qqResponses: number
			purchaseId: string
			createdAt: string
			status: string
			amount: number
			country?: string | null
		}>
	}>
}

export function parseQuickQuestionCsvForIdentity(csv: string): {
	rows: number
	identities: QuickQuestionIdentityRow[]
} {
	const records = parseCsv(csv)
	const identities: QuickQuestionIdentityRow[] = []
	for (const record of records) {
		const email = normalizeEmail(
			record.User ??
				record.user ??
				record.email ??
				record.Email ??
				record['Sender Email'],
		)
		if (!email) continue
		identities.push({
			email,
			rowId:
				record['Conversation ID'] ??
				record.conversationId ??
				record.response_id ??
				record.sourceResponseId,
		})
	}
	return { rows: records.length, identities }
}

export function parseQuickQuestionAnalysisJsonForIdentity(jsonText: string): {
	rows: number
	identities: QuickQuestionIdentityRow[]
} {
	const parsed = JSON.parse(jsonText) as {
		conversations?: Array<{ id?: string; recipient?: string }>
	}
	const conversations = parsed.conversations ?? []
	return {
		rows: conversations.length,
		identities: conversations.flatMap((conversation) => {
			const email = normalizeEmail(conversation.recipient)
			return email ? [{ email, rowId: conversation.id }] : []
		}),
	}
}

export async function previewPurchaseCorrelation(args: {
	repository: PurchasePreviewRepository
	quickQuestionCsv?: string
	quickQuestionAnalysisJson?: string
	productIds: string[]
	matchedExampleLimit?: number
}): Promise<PurchasePreviewResult> {
	const parsedSources = [
		args.quickQuestionCsv
			? parseQuickQuestionCsvForIdentity(args.quickQuestionCsv)
			: undefined,
		args.quickQuestionAnalysisJson
			? parseQuickQuestionAnalysisJsonForIdentity(
					args.quickQuestionAnalysisJson,
				)
			: undefined,
	].filter(
		(
			source,
		): source is { rows: number; identities: QuickQuestionIdentityRow[] } =>
			Boolean(source),
	)
	const parsed = {
		rows: parsedSources.reduce((total, source) => total + source.rows, 0),
		identities: parsedSources.flatMap((source) => source.identities),
	}
	const qqCountsByEmail = new Map<string, number>()
	for (const identity of parsed.identities) {
		qqCountsByEmail.set(
			identity.email,
			(qqCountsByEmail.get(identity.email) ?? 0) + 1,
		)
	}
	const products = await args.repository.findProductsByIds(args.productIds)
	const productNames = new Map(
		products.map((product) => [product.id, product.name]),
	)
	const purchases = await args.repository.findPurchasesByProductIds(
		args.productIds,
	)
	const exampleLimit = args.matchedExampleLimit ?? 12

	return {
		mode: 'read-only-preview',
		privacy: { rawEmailsIncluded: false, rawPayloadIncluded: false },
		quickQuestion: {
			rows: parsed.rows,
			rowsWithEmail: parsed.identities.length,
			uniqueEmails: qqCountsByEmail.size,
		},
		products: args.productIds.map((productId) => {
			const productPurchases = purchases.filter(
				(purchase) => purchase.productId === productId,
			)
			const matched = productPurchases.filter((purchase) =>
				purchase.email
					? qqCountsByEmail.has(normalizeEmail(purchase.email) ?? '')
					: false,
			)
			return {
				productId,
				productName:
					productNames.get(productId) ??
					productPurchases[0]?.productName ??
					'Unknown product',
				totalPurchases: productPurchases.length,
				matchedPurchases: matched.length,
				matchedUniqueEmails: new Set(
					matched
						.map((purchase) => normalizeEmail(purchase.email))
						.filter(Boolean),
				).size,
				byStatus: summarizeByStatus(productPurchases),
				matchedByStatus: summarizeByStatus(matched),
				matchedExamples: matched.slice(0, exampleLimit).map((purchase) => {
					const email = normalizeEmail(purchase.email) ?? ''
					return {
						emailHash: hashEmail(email),
						domain: email.split('@')[1] ?? 'unknown',
						qqResponses: qqCountsByEmail.get(email) ?? 0,
						purchaseId: purchase.purchaseId,
						createdAt: purchase.createdAt,
						status: purchase.status,
						amount: purchase.totalAmount,
						country: purchase.country,
					}
				}),
			}
		}),
	}
}

function summarizeByStatus(purchases: PurchasePreviewPurchase[]) {
	const summary: Record<string, { count: number; gross: number }> = {}
	for (const purchase of purchases) {
		const statusSummary = (summary[purchase.status] ??= { count: 0, gross: 0 })
		statusSummary.count += 1
		statusSummary.gross += purchase.totalAmount
	}
	return summary
}

function normalizeEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}

function hashEmail(email: string) {
	return createHash('sha256').update(email).digest('hex').slice(0, 12)
}

function parseCsv(text: string): Array<Record<string, string>> {
	const rows: string[][] = []
	let row: string[] = []
	let cell = ''
	let quoted = false
	for (let index = 0; index < text.length; index++) {
		const char = text[index]
		const next = text[index + 1]
		if (quoted && char === '"' && next === '"') {
			cell += '"'
			index += 1
		} else if (char === '"') {
			quoted = !quoted
		} else if (!quoted && char === ',') {
			row.push(cell)
			cell = ''
		} else if (!quoted && (char === '\n' || char === '\r')) {
			if (char === '\r' && next === '\n') index += 1
			row.push(cell)
			cell = ''
			if (row.some((value) => value !== '')) rows.push(row)
			row = []
		} else {
			cell += char
		}
	}
	row.push(cell)
	if (row.some((value) => value !== '')) rows.push(row)
	const header = rows.shift() ?? []
	return rows.map((values) =>
		Object.fromEntries(
			header.map((field, index) => [field, values[index] ?? '']),
		),
	)
}
