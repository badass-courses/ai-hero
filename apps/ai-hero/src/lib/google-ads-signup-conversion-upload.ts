import { createHash } from 'node:crypto'
import { formatGoogleAdsConversionDateTime } from './google-ads-conversion-upload'
import type { OptInAttribution } from './subscriber-marketing/opt-in-attribution'

export type SignupConversionCandidate = { contactId: string; occurredAt: string; attribution: OptInAttribution }
export type PreparedSignupConversion = {
	contactId: string; conversionActionResourceName: string; clickIdType: 'gclid'|'gbraid'|'wbraid'; clickIdValue: string; clickIdHash: string
	conversionDateTime: string; conversionValue: 0; currencyCode: 'USD'; orderId: string; idempotencyKey: string; requestSummary: Record<string, unknown>
}

export function prepareGoogleAdsSignupConversion(args: { candidate: SignupConversionCandidate; conversionActionResourceName?: string }) {
	const resource = args.conversionActionResourceName?.trim()
	if (!resource) return { ok: false as const, reason: 'missing-conversion-action-resource' }
	const values = [['gclid', args.candidate.attribution.gclid], ['gbraid', args.candidate.attribution.gbraid], ['wbraid', args.candidate.attribution.wbraid]] as const
	if (values.some(([, value]) => value?.startsWith('TEST_'))) return { ok: false as const, reason: 'synthetic-click-id' }
	const selected = values.find(([, value]) => value?.trim())
	if (!selected) return { ok: false as const, reason: 'missing-google-click-id' }
	const [clickIdType, clickIdValue] = selected as [typeof selected[0], string]
	const clickIdHash = createHash('sha256').update(clickIdValue).digest('hex')
	const idempotencyKey = `google-ads-signup:${args.candidate.contactId}:${resource}`
	const conversionDateTime = formatGoogleAdsConversionDateTime(args.candidate.occurredAt)
	const orderId = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 32)
	const requestSummary = { contactId: args.candidate.contactId, conversionActionResourceName: resource, clickIdType, clickIdHash, conversionDateTime, conversionValue: 0, currencyCode: 'USD', orderId }
	return { ok: true as const, conversion: { contactId: args.candidate.contactId, conversionActionResourceName: resource, clickIdType, clickIdValue, clickIdHash, conversionDateTime, conversionValue: 0 as const, currencyCode: 'USD' as const, orderId, idempotencyKey, requestSummary } }
}

export function buildSignupConversionPreview(candidates: SignupConversionCandidate[]) {
	const rows = candidates.flatMap((candidate) => {
		const values = [['gclid', candidate.attribution.gclid], ['gbraid', candidate.attribution.gbraid], ['wbraid', candidate.attribution.wbraid]] as const
		const selected = values.find(([, value]) => value?.trim())
		if (!selected) return []
		return [{ clickIdType: selected[0], synthetic: selected[1]!.startsWith('TEST_'), conversionTime: candidate.attribution.subscribedAt ?? candidate.occurredAt }]
	})
	return { rows, counts: { scanned: candidates.length, withClickEvidence: rows.length, synthetic: rows.filter((row) => row.synthetic).length, real: rows.filter((row) => !row.synthetic).length }, privacy: 'aggregate-preview-no-click-ids-no-emails-no-contact-ids' as const }
}

export function prepareSignupConversionBatch(args: { candidates: SignupConversionCandidate[]; conversionActionResourceName?: string }) {
	const prepared: PreparedSignupConversion[] = []; const excluded: Record<string, number> = {}
	for (const candidate of args.candidates) { const result = prepareGoogleAdsSignupConversion({ candidate, conversionActionResourceName: args.conversionActionResourceName }); if (result.ok) prepared.push(result.conversion); else excluded[result.reason] = (excluded[result.reason] ?? 0) + 1 }
	return { prepared, counts: { scanned: args.candidates.length, eligible: prepared.length, excluded } }
}
