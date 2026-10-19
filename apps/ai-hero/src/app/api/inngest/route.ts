import { inngestConfig } from '@/inngest/inngest.config'
import { inngestServeHost } from '@/inngest/serve-host'
import { withInngestFailureLogging } from '@/inngest/serve-failure-logging'
import { withSkill } from '@/server/with-skill'
import { serve } from 'inngest/next'

export const maxDuration = 800

// Production registers the public www URL, never the protected deployment
// URL the sync workflow reaches it on (see inngest/serve-host).
const inngest = serve({
	...inngestConfig,
	serveHost: inngestServeHost(process.env),
})

export const GET = withSkill(inngest.GET)
export const POST = withSkill(withInngestFailureLogging(inngest.POST))
export const PUT = withSkill(inngest.PUT)
