import { createHash } from 'node:crypto'

import {
	lookupSubscriberMarketingContact,
	type OperatorLookupRepository,
} from './operator-lookup'
import {
	parseQuickQuestionCsvForIdentity,
	type PurchasePreviewRepository,
	type PurchasePreviewPurchase,
} from './purchase-preview'
import { previewValuePathForContactSnapshot } from './value-path-planner'

export type MatchedPurchaserValuePathPreviewResult = {
	mode: 'matched-purchaser-value-path-preview'
	privacy: {
		rawEmailsIncluded: false
		rawPayloadIncluded: false
	}
	quickQuestion: {
		rows: number
		rowsWithEmail: number
		uniqueEmails: number
	}
	matches: {
		uniqueMatchedEmails: number
		matchedPurchases: number
		contactsFound: number
		contactsMissing: number
		ambiguousLookups: number
	}
	candidates: Array<{
		emailHash: string
		domain: string
		qqResponses: number
		matchedProducts: Array<{
			productId: string
			productName: string
			purchaseCount: number
			statuses: string[]
		}>
		lookup: {
			contacts: number
			ambiguous: boolean
			contactIds: string[]
		}
		valuePaths: Array<{
			contactId: string
			path: string
			offer?: string
			status: string
			reviewReasons: string[]
			gates: Array<{ slug: string; passed: boolean; reason: string }>
			rationale: string[]
		}>
	}>
}

export async function previewMatchedPurchaserValuePaths(args: {
	purchaseRepository: PurchasePreviewRepository
	lookupRepository: OperatorLookupRepository
	quickQuestionCsv: string
	productIds: string[]
	limit?: number
}): Promise<MatchedPurchaserValuePathPreviewResult> {
	const parsed = parseQuickQuestionCsvForIdentity(args.quickQuestionCsv)
	const qqCountsByEmail = new Map<string, number>()
	for (const identity of parsed.identities) {
		qqCountsByEmail.set(
			identity.email,
			(qqCountsByEmail.get(identity.email) ?? 0) + 1,
		)
	}

	const purchases = await args.purchaseRepository.findPurchasesByProductIds(
		args.productIds,
	)
	const matchedPurchasesByEmail = new Map<string, PurchasePreviewPurchase[]>()
	for (const purchase of purchases) {
		const email = normalizeEmail(purchase.email)
		if (!email || !qqCountsByEmail.has(email)) continue
		const existing = matchedPurchasesByEmail.get(email) ?? []
		existing.push(purchase)
		matchedPurchasesByEmail.set(email, existing)
	}

	const matchedEmails = Array.from(matchedPurchasesByEmail.keys()).sort()
	const limit = args.limit ?? matchedEmails.length
	const candidates = []
	let contactsFound = 0
	let contactsMissing = 0
	let ambiguousLookups = 0

	for (const email of matchedEmails.slice(0, limit)) {
		const matchedPurchases = matchedPurchasesByEmail.get(email) ?? []
		const lookup = await lookupSubscriberMarketingContact({
			repository: args.lookupRepository,
			input: { type: 'email', email },
			limit: 10,
		})
		if (lookup.contacts.length === 0) contactsMissing += 1
		else contactsFound += lookup.contacts.length
		if (lookup.ambiguous) ambiguousLookups += 1

		const valuePaths = lookup.contacts.map((snapshot) => {
			const preview = previewValuePathForContactSnapshot({
				snapshot,
				purchaseFacts: matchedPurchases,
			})
			return {
				contactId: snapshot.contact.id,
				path: preview.candidate.path,
				offer: preview.candidate.offer,
				status: preview.candidate.status,
				reviewReasons: preview.candidate.reviewReasons,
				gates: preview.candidate.gates,
				rationale: preview.candidate.rationale,
			}
		})

		candidates.push({
			emailHash: hashEmail(email),
			domain: email.split('@')[1] ?? 'unknown',
			qqResponses: qqCountsByEmail.get(email) ?? 0,
			matchedProducts: summarizeMatchedProducts(matchedPurchases),
			lookup: {
				contacts: lookup.contacts.length,
				ambiguous: lookup.ambiguous,
				contactIds: lookup.contacts.map((snapshot) => snapshot.contact.id),
			},
			valuePaths,
		})
	}

	return {
		mode: 'matched-purchaser-value-path-preview',
		privacy: { rawEmailsIncluded: false, rawPayloadIncluded: false },
		quickQuestion: {
			rows: parsed.rows,
			rowsWithEmail: parsed.identities.length,
			uniqueEmails: qqCountsByEmail.size,
		},
		matches: {
			uniqueMatchedEmails: matchedEmails.length,
			matchedPurchases: Array.from(matchedPurchasesByEmail.values()).reduce(
				(total, emailPurchases) => total + emailPurchases.length,
				0,
			),
			contactsFound,
			contactsMissing,
			ambiguousLookups,
		},
		candidates,
	}
}

function summarizeMatchedProducts(purchases: PurchasePreviewPurchase[]) {
	const byProduct = new Map<string, PurchasePreviewPurchase[]>()
	for (const purchase of purchases) {
		const productPurchases = byProduct.get(purchase.productId) ?? []
		productPurchases.push(purchase)
		byProduct.set(purchase.productId, productPurchases)
	}
	return Array.from(byProduct.entries()).map(
		([productId, productPurchases]) => ({
			productId,
			productName: productPurchases[0]?.productName ?? 'Unknown product',
			purchaseCount: productPurchases.length,
			statuses: Array.from(
				new Set(productPurchases.map((purchase) => purchase.status)),
			).sort(),
		}),
	)
}

function normalizeEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	return normalized && normalized.includes('@') ? normalized : undefined
}

function hashEmail(email: string) {
	return createHash('sha256').update(email).digest('hex').slice(0, 12)
}
