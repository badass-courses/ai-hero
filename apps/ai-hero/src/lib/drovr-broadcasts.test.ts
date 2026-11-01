import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
	approveDrovrBroadcast,
	buildDrovrMessageFile,
	createDrovrBroadcastClient,
	drovrApprovalBlocks,
	drovrSendPlan,
	prepareDrovrSkillsMessage,
	type DrovrBroadcastClient,
} from './drovr-broadcasts'

const plan = {
	campaignId: 'aihero-skills-changelog',
	campaignDisplayName: 'AI Hero Skills',
	layoutId: 'aihero-newsletter@drovr-1',
	perHour: 6000,
	hourly: 6000,
	daily: 60000,
	tickMs: 60000,
}

const drovrEnv = {
	AI_HERO_SKILLS_DROVR_SEND_PLAN: JSON.stringify(plan),
	AI_HERO_BROADCAST_APPROVER_SLACK_IDS: 'U_APPROVER, U_OTHER',
}

const report = {
	broadcastId: null,
	phase: 'capturing',
	captured: 0,
	sent: 0,
	nextMoves: [],
}

function fakeClient(
	overrides: Partial<DrovrBroadcastClient> = {},
): DrovrBroadcastClient {
	return {
		newMessage: vi.fn(async () => ({
			ok: true as const,
			value: {
				id: 'aihero.broadcast.skill-changelog-abc-1a2b3c4d',
				path: 'messages/aihero.broadcast.skill-changelog-abc-1a2b3c4d.md',
			},
		})),
		validateMessageFile: vi.fn(async (input) => ({
			ok: true as const,
			value: {
				messageId: 'aihero.broadcast.skill-changelog-abc-1a2b3c4d',
				path: input.path,
				status: 'cataloged' as const,
				reasons: [],
			},
		})),
		createBroadcast: vi.fn(async () => ({ ok: true as const, value: report })),
		createShardedBroadcast: vi.fn(async () => ({
			ok: true as const,
			value: report,
		})),
		broadcastStatus: vi.fn(async () => ({
			ok: true as const,
			value: { ...report, phase: 'sending', sent: 12 },
		})),
		shardedBroadcastStatus: vi.fn(async () => ({
			ok: true as const,
			value: report,
		})),
		...overrides,
	}
}

// Kit is unreachable for every test here: a Kit call fails the test.
const kitFetch = vi.fn(async (input: RequestInfo | URL) => {
	throw new Error(`Kit is unreachable: ${String(input)}`)
})

beforeEach(() => {
	kitFetch.mockClear()
	vi.stubGlobal('fetch', kitFetch)
})

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('drovr send plan config', () => {
	it('fails closed on a missing or partial send plan', () => {
		expect(drovrSendPlan({}).ok).toBe(false)
		expect(
			drovrSendPlan({ AI_HERO_SKILLS_DROVR_SEND_PLAN: '{not json' }).ok,
		).toBe(false)
		const { campaignId: _dropped, ...noCampaign } = plan
		expect(
			drovrSendPlan({
				AI_HERO_SKILLS_DROVR_SEND_PLAN: JSON.stringify(noCampaign),
			}),
		).toMatchObject({
			ok: false,
			reason: expect.stringContaining('campaignId'),
		})
	})
})

describe('drovr message file', () => {
	it('writes one-line JSON-quoted frontmatter and an HTML body', () => {
		const file = buildDrovrMessageFile({
			messageId: 'aihero.broadcast.x-1',
			subject: 'New skill:\n "agents"',
			previewText: null,
			content: 'First line\nsecond\n\nNext paragraph',
			layoutId: 'aihero-newsletter@drovr-1',
			provenance: 'ai-hero:skill-changelog/r1',
		})
		expect(file.path).toBe('messages/aihero.broadcast.x-1.md')
		expect(file.text).toBe(
			[
				'---',
				'id: "aihero.broadcast.x-1"',
				'kind: "broadcast"',
				'subject: "New skill: \\"agents\\""',
				'preview: "New skill: \\"agents\\""',
				'layout: "aihero-newsletter@drovr-1"',
				'from: {"address":"matt@aihero.dev","name":"Matt Pocock (AI Hero)"}',
				'format: "html"',
				'provenance: "ai-hero:skill-changelog/r1"',
				'---',
				'<p>First line<br />second</p>',
				'<p>Next paragraph</p>',
				'',
			].join('\n'),
		)
	})
})

describe('prepareDrovrSkillsMessage', () => {
	const input = {
		slug: 'abc',
		resourceId: 'r1',
		subject: 'Skills changelog',
		previewText: 'What changed',
		content: '<p>Hello</p>',
	}

	it('mints an id, validates the file, and creates no broadcast', async () => {
		const client = fakeClient()
		const prepared = await prepareDrovrSkillsMessage({
			...input,
			env: drovrEnv,
			client,
		})
		expect(prepared).toMatchObject({
			status: 'prepared',
			messageId: 'aihero.broadcast.skill-changelog-abc-1a2b3c4d',
			validation: { status: 'cataloged' },
		})
		expect(client.newMessage).toHaveBeenCalledWith({
			kind: 'broadcast',
			slug: 'skill changelog abc',
		})
		expect(client.validateMessageFile).toHaveBeenCalledWith({
			path: 'messages/aihero.broadcast.skill-changelog-abc-1a2b3c4d.md',
			text: expect.stringContaining('layout: "aihero-newsletter@drovr-1"'),
		})
		expect(client.createBroadcast).not.toHaveBeenCalled()
		expect(client.createShardedBroadcast).not.toHaveBeenCalled()
		expect(kitFetch).not.toHaveBeenCalled()
	})

	it('reuses a message id the resource already holds', async () => {
		const client = fakeClient()
		await prepareDrovrSkillsMessage({
			...input,
			existingMessageId: 'aihero.broadcast.kept-1',
			env: drovrEnv,
			client,
		})
		expect(client.newMessage).not.toHaveBeenCalled()
		expect(client.validateMessageFile).toHaveBeenCalledWith(
			expect.objectContaining({ path: 'messages/aihero.broadcast.kept-1.md' }),
		)
	})

	it('skips without a send plan or a drovr client', async () => {
		await expect(
			prepareDrovrSkillsMessage({ ...input, env: {}, client: fakeClient() }),
		).resolves.toMatchObject({ status: 'skipped' })
		await expect(
			prepareDrovrSkillsMessage({ ...input, env: drovrEnv, client: null }),
		).resolves.toEqual({
			status: 'skipped',
			reason: 'drovr is not configured',
		})
	})

	it('throws on a drovr refusal so the step retries', async () => {
		const client = fakeClient({
			validateMessageFile: vi.fn(async () => ({
				ok: false as const,
				status: 503,
				title: 'Content store unavailable',
			})),
		})
		await expect(
			prepareDrovrSkillsMessage({ ...input, env: drovrEnv, client }),
		).rejects.toThrow('drovr answered 503: Content store unavailable')
	})
})

describe('approveDrovrBroadcast', () => {
	const value = {
		messageId: 'aihero.broadcast.x-1',
		version: 'v-abc',
		subject: 'Skills changelog',
		shortlink: 'https://aihero.dev/s/x',
	}

	it('creates one Tenant broadcast for the approved version, starting now', async () => {
		const client = fakeClient()
		const outcome = await approveDrovrBroadcast({
			value,
			approverSlackId: 'U_APPROVER',
			env: drovrEnv,
			client,
			now: () => 1_700_000_000_000,
		})
		expect(outcome).toEqual({
			status: 'created',
			broadcastId: 'aihero.broadcast.x-1@v-abc',
			report,
		})
		expect(client.createBroadcast).toHaveBeenCalledTimes(1)
		expect(client.createBroadcast).toHaveBeenCalledWith({
			draft: {
				at: 1_700_000_000_000,
				broadcastId: 'aihero.broadcast.x-1@v-abc',
				campaign: {
					id: 'aihero-skills-changelog',
					displayName: 'AI Hero Skills',
				},
				caps: { hourly: 6000, daily: 60000 },
				messageId: 'aihero.broadcast.x-1',
				pace: { kind: 'rate', perHour: 6000 },
				tenantId: 'org-aihero',
				tickMs: 60000,
				version: 'v-abc',
			},
			selector: { _tag: 'Tenant' },
			startAt: 'now',
		})
		expect(kitFetch).not.toHaveBeenCalled()
	})

	it.each([
		['the clicker is not an approver', drovrEnv, 'U_SOMEONE'],
		[
			'no approvers are configured',
			{ ...drovrEnv, AI_HERO_BROADCAST_APPROVER_SLACK_IDS: '' },
			'U_APPROVER',
		],
		[
			'the send plan is missing',
			{ ...drovrEnv, AI_HERO_SKILLS_DROVR_SEND_PLAN: '' },
			'U_APPROVER',
		],
	])('refuses and creates nothing when %s', async (_case, env, approver) => {
		const client = fakeClient()
		const outcome = await approveDrovrBroadcast({
			value,
			approverSlackId: approver,
			env,
			client,
		})
		expect(outcome.status).toBe('refused')
		expect(client.createBroadcast).not.toHaveBeenCalled()
		expect(client.createShardedBroadcast).not.toHaveBeenCalled()
		expect(kitFetch).not.toHaveBeenCalled()
	})

	it('meets a second approval with the first broadcast, not a second send', async () => {
		const client = fakeClient({
			createBroadcast: vi.fn(async () => ({
				ok: false as const,
				status: 409,
				problemType: 'urn:drovr:problem:broadcast-already-initialized',
			})),
		})
		const outcome = await approveDrovrBroadcast({
			value,
			approverSlackId: 'U_APPROVER',
			env: drovrEnv,
			client,
		})
		expect(outcome).toMatchObject({
			status: 'already_created',
			broadcastId: 'aihero.broadcast.x-1@v-abc',
			report: { phase: 'sending', sent: 12 },
		})
		expect(client.broadcastStatus).toHaveBeenCalledWith({
			broadcastId: 'aihero.broadcast.x-1@v-abc',
			tenantId: 'org-aihero',
		})
	})

	it('reports an owner-required refusal instead of retrying elsewhere', async () => {
		const client = fakeClient({
			createBroadcast: vi.fn(async () => ({
				ok: false as const,
				status: 403,
				title: 'Broadcast owner required',
				problemType: 'urn:drovr:problem:broadcast-owner-required',
			})),
		})
		const outcome = await approveDrovrBroadcast({
			value,
			approverSlackId: 'U_APPROVER',
			env: drovrEnv,
			client,
		})
		expect(outcome).toEqual({
			status: 'refused',
			reason:
				'drovr answered 403: Broadcast owner required: urn:drovr:problem:broadcast-owner-required',
		})
		expect(kitFetch).not.toHaveBeenCalled()
	})

	it('splits across shards when the plan asks for them', async () => {
		const client = fakeClient()
		await approveDrovrBroadcast({
			value,
			approverSlackId: 'U_APPROVER',
			env: {
				...drovrEnv,
				AI_HERO_SKILLS_DROVR_SEND_PLAN: JSON.stringify({ ...plan, shards: 8 }),
			},
			client,
		})
		expect(client.createBroadcast).not.toHaveBeenCalled()
		expect(client.createShardedBroadcast).toHaveBeenCalledWith(
			expect.objectContaining({
				shards: { count: 8 },
				selector: { _tag: 'Tenant' },
				startAt: 'now',
			}),
		)
	})
})

describe('drovr approval blocks', () => {
	it('asks Slack to confirm before the click reaches the approval route', () => {
		const blocks = drovrApprovalBlocks({
			messageId: 'm',
			version: 'v',
			subject: 's',
			shortlink: 'https://aihero.dev/s/x',
		})
		const button = (blocks[1] as any).elements[0]
		expect(button.action_id).toBe('ai_hero_skills_approve_drovr_send')
		expect(button.confirm).toBeDefined()
		expect(JSON.parse(button.value)).toEqual({
			messageId: 'm',
			version: 'v',
			subject: 's',
			shortlink: 'https://aihero.dev/s/x',
		})
	})
})

describe('a malformed 200 from create_broadcast', () => {
	const value = {
		messageId: 'aihero.broadcast.x-1',
		version: 'v-abc',
		subject: 'Skills changelog',
		shortlink: 'https://aihero.dev/s/x',
	}

	it.each([
		['an empty body', ''],
		['not JSON', 'ok'],
		['no broadcast', '{"nextMoves":[]}'],
		['a broadcast without capture fields', '{"broadcast":{"phase":"sending"}}'],
		[
			'an unknown phase',
			'{"broadcast":{"captureComplete":true,"captured":3,"phase":"maybe"}}',
		],
		[
			'a sharded answer without a broadcast id',
			'{"sharded":{"captureComplete":true,"captured":3}}',
		],
	])('with %s is an unconfirmed send, never "sending"', async (_case, text) => {
		const client = createDrovrBroadcastClient({
			config: { baseUrl: 'https://drovr.test', apiKey: 'k' },
			fetcher: vi.fn(
				async () => new Response(text, { status: 200 }),
			) as unknown as typeof fetch,
		})
		const outcome = await approveDrovrBroadcast({
			value,
			approverSlackId: 'U_APPROVER',
			env: {
				...drovrEnv,
				AI_HERO_SKILLS_DROVR_SEND_PLAN: JSON.stringify(
					text.includes('sharded') ? { ...plan, shards: 2 } : plan,
				),
			},
			client,
		})
		expect(outcome).toEqual({
			status: 'refused',
			reason:
				'drovr gave an unreadable answer; the send is unconfirmed, check broadcast_status for aihero.broadcast.x-1@v-abc',
		})
	})

	it('naming another broadcast is an unconfirmed send', async () => {
		const client = fakeClient({
			createShardedBroadcast: vi.fn(async () => ({
				ok: true as const,
				value: { ...report, broadcastId: 'someone-else' },
			})),
		})
		const outcome = await approveDrovrBroadcast({
			value,
			approverSlackId: 'U_APPROVER',
			env: {
				...drovrEnv,
				AI_HERO_SKILLS_DROVR_SEND_PLAN: JSON.stringify({ ...plan, shards: 2 }),
			},
			client,
		})
		expect(outcome).toMatchObject({
			status: 'refused',
			reason: expect.stringContaining('the send is unconfirmed'),
		})
	})
})

describe('createDrovrBroadcastClient', () => {
	it('POSTs create_broadcast with the tenant key and reads the status', async () => {
		const fetcher = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						broadcast: {
							captureComplete: false,
							phase: 'capturing',
							captured: 0,
							stats: { sent: 0 },
						},
						nextMoves: ['broadcast_status'],
					}),
					{ status: 200 },
				),
		)
		const client = createDrovrBroadcastClient({
			config: { baseUrl: 'https://drovr.test/', apiKey: 'tenant-key' },
			fetcher: fetcher as unknown as typeof fetch,
		})!
		const input = {
			draft: {
				at: 1,
				broadcastId: 'b',
				campaign: { id: 'c', displayName: 'C' },
				caps: { hourly: 1, daily: 1 },
				messageId: 'm',
				pace: { kind: 'rate' as const, perHour: 1 },
				tenantId: 'org-aihero',
				tickMs: 60000,
				version: 'v',
			},
			selector: { _tag: 'Tenant' as const },
			startAt: 'now' as const,
		}
		await expect(client.createBroadcast(input)).resolves.toEqual({
			ok: true,
			value: {
				broadcastId: null,
				phase: 'capturing',
				captured: 0,
				sent: 0,
				nextMoves: ['broadcast_status'],
			},
		})
		expect(fetcher).toHaveBeenCalledWith(
			'https://drovr.test/create_broadcast',
			expect.objectContaining({
				method: 'POST',
				body: JSON.stringify(input),
				headers: expect.objectContaining({
					authorization: 'Bearer tenant-key',
				}),
			}),
		)
	})

	it('keeps a problem refusal and never reads an odd 200 as success', async () => {
		const problem = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						type: 'urn:drovr:problem:broadcast-owner-required',
						title: 'Broadcast owner required',
						detail: 'A tenant owner must perform broadcast mutations',
						status: 403,
					}),
					{ status: 403 },
				),
		)
		const refused = createDrovrBroadcastClient({
			config: { baseUrl: 'https://drovr.test', apiKey: 'k' },
			fetcher: problem as unknown as typeof fetch,
		})!
		await expect(
			refused.validateMessageFile({ path: 'messages/m.md', text: 'x' }),
		).resolves.toMatchObject({
			ok: false,
			status: 403,
			problemType: 'urn:drovr:problem:broadcast-owner-required',
		})

		const odd = createDrovrBroadcastClient({
			config: { baseUrl: 'https://drovr.test', apiKey: 'k' },
			fetcher: vi.fn(
				async () => new Response('{"status":"maybe"}', { status: 200 }),
			) as unknown as typeof fetch,
		})!
		await expect(
			odd.validateMessageFile({ path: 'messages/m.md', text: 'x' }),
		).resolves.toMatchObject({ ok: false, status: 200 })
	})

	it('is absent without a base URL or key', () => {
		expect(
			createDrovrBroadcastClient({
				config: { baseUrl: undefined, apiKey: 'k' },
			}),
		).toBeNull()
	})
})
