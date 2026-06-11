import { Axiom } from '@axiomhq/js'

import { log } from '../src/server/logger'
import { withSkill } from '../src/server/with-skill'

type SmokeSummary = {
	smokeId: string
	dataset: string | null
	axiomQueryEnabled: boolean
	queryError?: string
	matches: number
	events: Record<string, number>
	fieldsPresent: {
		requestId: boolean
		path: boolean
		method: boolean
		status: boolean
		durationMs: boolean
	}
}

function createRequest(path: string, method = 'GET', smokeId: string): Request {
	const separator = path.includes('?') ? '&' : '?'
	return new Request(
		`https://aihero.dev${path}${separator}smokeId=${smokeId}`,
		{
			method,
			headers: {
				'user-agent': 'api-request-telemetry-smoke',
				'x-forwarded-for': '198.51.100.9',
			},
		},
	)
}

async function run(): Promise<void> {
	const smokeId = `smoke_${Date.now()}`
	const dataset = process.env.NEXT_PUBLIC_AXIOM_DATASET ?? null
	const axiomToken = process.env.AXIOM_TOKEN
	const axiomOrgId = process.env.AXIOM_ORG_ID || 'ai-hero'

	const summary: SmokeSummary = {
		smokeId,
		dataset,
		axiomQueryEnabled: Boolean(dataset && axiomToken),
		matches: 0,
		events: {},
		fieldsPresent: {
			requestId: false,
			path: false,
			method: false,
			status: false,
			durationMs: false,
		},
	}

	const successGet = withSkill(async () => {
		return Response.json({ ok: true }, { status: 200 })
	})

	const successPost = withSkill(async () => {
		return new Response(null, { status: 204 })
	})

	const failureGet = withSkill(async () => {
		throw new Error('api_request_telemetry_smoke_failure')
	})

	await successGet(
		createRequest('/api/smoke/success?token=super-secret', 'GET', smokeId),
	)
	await successPost(
		createRequest('/api/smoke/create?apiKey=super-secret', 'POST', smokeId),
	)

	try {
		await failureGet(
			createRequest('/api/smoke/failure?password=super-secret', 'GET', smokeId),
		)
	} catch {
		// Expected failure path for api.request.failed validation.
	}

	await log.flush()

	if (!dataset || !axiomToken) {
		console.log(
			JSON.stringify(
				{
					...summary,
					message:
						'Axiom query skipped because AXIOM_TOKEN or NEXT_PUBLIC_AXIOM_DATASET is missing.',
				},
				null,
				2,
			),
		)
		return
	}

	const axiom = new Axiom({
		token: axiomToken,
		orgId: axiomOrgId,
	})

	const apl = [
		`['${dataset}']`,
		"| where event in ['api.request.started', 'api.request.completed', 'api.request.failed']",
		`| where queryString contains '${smokeId}'`,
		'| sort by _time asc',
		'| limit 50',
	].join(' ')

	try {
		const result = await axiom.query(apl, {
			startTime: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
			endTime: new Date().toISOString(),
		})

		const matches = (result.matches ?? []).map(
			(match) => match as unknown as Record<string, unknown>,
		)
		summary.matches = matches.length

		for (const match of matches) {
			const event =
				typeof match.event === 'string' ? String(match.event) : 'unknown'
			summary.events[event] = (summary.events[event] ?? 0) + 1
		}

		const hasField = (field: string) =>
			matches.some(
				(match) => match[field] !== undefined && match[field] !== null,
			)

		summary.fieldsPresent = {
			requestId: hasField('requestId'),
			path: hasField('path'),
			method: hasField('method'),
			status: hasField('status'),
			durationMs: hasField('durationMs'),
		}

		console.log(JSON.stringify(summary, null, 2))

		const requiredEvents = [
			'api.request.started',
			'api.request.completed',
			'api.request.failed',
		]
		const allEventsPresent = requiredEvents.every(
			(event) => (summary.events[event] ?? 0) > 0,
		)
		const requiredFieldsPresent = Object.values(summary.fieldsPresent).every(
			Boolean,
		)

		if (!allEventsPresent || !requiredFieldsPresent) {
			process.exitCode = 1
		}
	} catch (error) {
		summary.queryError = error instanceof Error ? error.message : String(error)
		console.log(JSON.stringify(summary, null, 2))
	}
}

run().catch((error) => {
	console.error('smoke-api-request-telemetry failed:', error)
	process.exit(1)
})
