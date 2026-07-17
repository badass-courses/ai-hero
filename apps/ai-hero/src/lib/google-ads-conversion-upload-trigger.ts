type GoogleAdsUploadTrigger =
	| { kind: 'purchase-event'; purchaseId?: string }
	| { kind: 'scheduled-cron' }

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function classifyGoogleAdsUploadTrigger(
	event: unknown,
	purchaseEventName: string,
): GoogleAdsUploadTrigger {
	if (!isRecord(event) || event.name !== purchaseEventName) {
		return { kind: 'scheduled-cron' }
	}
	const data = isRecord(event.data) ? event.data : undefined
	const purchaseId =
		typeof data?.purchaseId === 'string' ? data.purchaseId.trim() : undefined
	return {
		kind: 'purchase-event',
		...(purchaseId ? { purchaseId } : {}),
	}
}
