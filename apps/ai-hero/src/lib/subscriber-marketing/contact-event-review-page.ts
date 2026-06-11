import type { ContactEventPreviewSummary } from './contact-event-normalizer-preview'

export function renderContactEventReviewHtml(args: {
	title: string
	sourceTable: string
	preview: ContactEventPreviewSummary
	nextWriteCommand?: string
}) {
	const shouldWrite = args.preview.eligibleCount > 0
	const skipReasons = Object.entries(args.preview.skippedByReason)
		.map(([reason, count]) => `<li>${escapeHtml(reason)}: ${count}</li>`)
		.join('')
	const samples = args.preview.samples
		.slice(0, 12)
		.map((sample) => {
			if (sample.status === 'eligible') {
				return `<li>${escapeHtml(sample.sourceId)}: safe. ${escapeHtml(sample.identityResolutionPath)}</li>`
			}
			return `<li>${escapeHtml(sample.sourceId)}: skip. ${escapeHtml(sample.reason)}</li>`
		})
		.join('')
	const nextCommand = shouldWrite
		? (args.nextWriteCommand ?? 'Run a tiny --allow-write batch after review.')
		: 'Do not write yet. Fix identity links first.'

	return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(args.title)}</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 20px;line-height:1.45}pre{white-space:pre-wrap;background:#eee;padding:12px}code{background:#eee;padding:2px 4px}.box{border:1px solid #ccc;padding:14px;margin:14px 0}</style></head><body><h1>${escapeHtml(args.title)}</h1><div class="box"><h2>Do this</h2><p><strong>${shouldWrite ? 'Review samples, then run a tiny write.' : 'Do not write yet.'}</strong></p><pre>${escapeHtml(nextCommand)}</pre></div><div class="box"><h2>What this is</h2><p>These are database rows from <code>${escapeHtml(args.sourceTable)}</code>. They are not logs.</p><ul><li>Safe rows: ${args.preview.eligibleCount}</li><li>Skipped rows: ${args.preview.skippedCount}</li></ul></div><div class="box"><h2>Why skipped</h2><ul>${skipReasons || '<li>None</li>'}</ul></div><div class="box"><h2>Sample rows</h2><ul>${samples || '<li>No samples</li>'}</ul></div><div class="box"><h2>Safety</h2><ul><li>Kit writes: ${args.preview.kitWrites}</li><li>Sequence enrollments: ${args.preview.sequenceEnrollments}</li><li>Customer-visible effects: ${args.preview.customerVisibleSideEffects}</li></ul></div></body></html>`
}

function escapeHtml(value: unknown) {
	return String(value)
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;')
}
