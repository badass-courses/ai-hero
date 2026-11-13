import { inngest } from '@/inngest/inngest.server'
import { runProfileRestatementSweep } from '@/lib/subscriber-marketing/drovr-profile-restatement-sweep'

export const drovrProfileRestatementSweep = inngest.createFunction(
	{
		id: 'drovr-profile-restatement-sweep-v1',
		name: 'drovr: discover profiles due for re-statement',
		retries: 3,
		concurrency: [{ limit: 1 }],
	},
	{ cron: '0 6 * * *' },
	async ({ step }) => {
		const [
			{ db },
			{ env },
			{ createDrizzleContactProfileRestatementStore },
			{ drovrApiKeyForTenant, DROVR_AUTHORITY_TENANT_ID },
		] = await Promise.all([
			import('@/db'),
			import('@/env.mjs'),
			import('@/lib/subscriber-marketing/contact-profile-version-drizzle'),
			import('@/lib/subscriber-marketing/drovr-shadow-emitter'),
		])
		const startedAt = (await step.run('started-at', async () =>
			new Date().toISOString(),
		)) as string
		return runProfileRestatementSweep({
			step,
			env: process.env,
			configured: Boolean(
				env.DROVR_SHADOW_INGEST_URL &&
				drovrApiKeyForTenant(DROVR_AUTHORITY_TENANT_ID),
			),
			startedAt,
			store: createDrizzleContactProfileRestatementStore(db),
		})
	},
)
