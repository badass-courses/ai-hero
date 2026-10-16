import { afterEach, expect, it, vi } from 'vitest'
import {
	BACKFILL_DUNGEON_CONFIRMATION,
	BACKFILL_DUNGEON_FLAG,
	requireBackfillDungeonOverride,
} from '@/lib/subscriber-marketing/contact-sync-backfill-dungeon'
import { runContactSyncBackfill } from '@/lib/subscriber-marketing/contact-sync-backfill'

const m = vi.hoisted(() => ({
	capture: vi.fn(),
	acknowledge: vi.fn(),
	versions: vi.fn(),
}))
vi.mock('@/db', () => ({ db: {} }))
vi.mock('@/inngest/inngest.server', () => ({
	inngest: {
		createFunction: (
			_config: unknown,
			_trigger: unknown,
			handler: unknown,
		) => ({ handler }),
	},
}))
vi.mock('@/lib/subscriber-marketing/drovr-outbox-live', () => ({
	captureDrovrOutboxLive: m.capture,
}))
vi.mock('@/lib/subscriber-marketing/contact-profile-version-drizzle', () => ({
	createDrizzleContactProfileVersionStore: m.versions,
}))
import { drovrContactSyncBackfill } from './drovr-contact-sync-backfill'

afterEach(() => {
	vi.unstubAllEnvs()
	vi.clearAllMocks()
})
it.each([
	undefined,
	'',
	'true',
	'1',
	'allow',
	BACKFILL_DUNGEON_CONFIRMATION.toLowerCase(),
])(
	'refuses the dungeoned full resync before any work for override %s',
	async (value) => {
		vi.stubEnv(BACKFILL_DUNGEON_FLAG, value ?? '')
		if (value === undefined) delete process.env[BACKFILL_DUNGEON_FLAG]
		vi.stubEnv('AIH_DROVR_PROFILE_SYNC', 'true')
		const step = { run: vi.fn(), sendEvent: vi.fn() }
		const ports = {
			now: vi.fn(),
			countEvents: vi.fn(),
			scanEvents: vi.fn(),
			snapshot: vi.fn(),
			versionFor: vi.fn(),
			persistEvents: vi.fn(),
			liveStopFacts: vi.fn(),
		}
		const message = `Joel ruled on 2026-10-15`
		await expect(
			runContactSyncBackfill({
				event: { data: { dryRun: true } },
				step,
				ports: ports as never,
				env: { AIH_DROVR_PROFILE_SYNC: 'true', [BACKFILL_DUNGEON_FLAG]: value },
			}),
		).rejects.toThrow(message)
		const handler = (
			drovrContactSyncBackfill as unknown as {
				handler: (args: unknown) => Promise<unknown>
			}
		).handler
		await expect(
			handler({ event: { data: { canary: true, dryRunCount: 1 } }, step }),
		).rejects.toThrow(BACKFILL_DUNGEON_CONFIRMATION)
		for (const call of Object.values(ports)) expect(call).not.toHaveBeenCalled()
		expect(step.run).not.toHaveBeenCalled()
		expect(step.sendEvent).not.toHaveBeenCalled()
		expect(m.capture).not.toHaveBeenCalled()
		expect(m.versions).not.toHaveBeenCalled()
		expect(m.acknowledge).not.toHaveBeenCalled()
	},
)
it('admits only the exact operator literal, without enabling or exercising the legacy producer here', () => {
	expect(() =>
		requireBackfillDungeonOverride({
			[BACKFILL_DUNGEON_FLAG]: BACKFILL_DUNGEON_CONFIRMATION,
		}),
	).not.toThrow()
})
