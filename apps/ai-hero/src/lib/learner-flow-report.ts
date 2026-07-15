const SUPPORT_REPOSITORY = 'badass-courses/aihero-support'
const CURRENT_REPORT_PATH = '.brain/data/learner-flow/current.json'
const REPORT_PATH = /^\.brain\/data\/learner-flow\/reports\/\d{4}-\d{2}-\d{2}\.json$/

type CurrentReport = {
	schemaVersion: 'aih.learner-flow.current.v1'
	productId: string
	reportPath: string
	reportSha256: string
	generatedAt: string
}

type FetchLike = typeof fetch

type ReadOptions = {
	token?: string
	fetch?: FetchLike
}

async function readPrivateJson(path: string, token: string, fetcher: FetchLike) {
	const response = await fetcher(`https://api.github.com/repos/${SUPPORT_REPOSITORY}/contents/${path}`, {
		headers: {
			Accept: 'application/vnd.github.raw+json',
			Authorization: `Bearer ${token}`,
			'X-GitHub-Api-Version': '2022-11-28',
		},
		cache: 'no-store',
	})
	if (response.status === 404) return null
	if (!response.ok) throw new Error(`support report read failed with ${response.status}`)
	return JSON.parse(await response.text()) as unknown
}

function isCurrentReport(value: unknown): value is CurrentReport {
	if (!value || typeof value !== 'object') return false
	const candidate = value as Partial<CurrentReport>
	return candidate.schemaVersion === 'aih.learner-flow.current.v1' &&
		typeof candidate.productId === 'string' &&
		typeof candidate.reportPath === 'string' &&
		typeof candidate.reportSha256 === 'string' &&
		typeof candidate.generatedAt === 'string' &&
		REPORT_PATH.test(candidate.reportPath)
}

/**
 * Reads the exact report generated from canonical support-repo snapshots.
 * The app does not re-derive live windows or duplicate delta math.
 */
export async function getLearnerFlowReport(options: ReadOptions = {}) {
	const token = options.token ?? process.env.AIH_SUPPORT_REPORT_READ_TOKEN?.trim()
	if (!token) return { state: 'unavailable' as const, reason: 'support_report_token_missing' as const }
	const fetcher = options.fetch ?? fetch
	try {
		const current = await readPrivateJson(CURRENT_REPORT_PATH, token, fetcher)
		if (!current) return { state: 'not_started' as const }
		if (!isCurrentReport(current)) return { state: 'unavailable' as const, reason: 'support_report_manifest_invalid' as const }
		const report = await readPrivateJson(current.reportPath, token, fetcher)
		if (!report || typeof report !== 'object') return { state: 'unavailable' as const, reason: 'support_report_missing' as const }
		return report
	} catch {
		return { state: 'unavailable' as const, reason: 'support_report_source_unavailable' as const }
	}
}
