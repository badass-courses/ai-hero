import {
	codingWorkflowFixture,
	restrictedFixture,
	supportFixture,
} from '@/lib/subscriber-marketing/__fixtures__/quick-question-fixtures'
import { dryRunSubscriberMarketingFixture } from '@/lib/subscriber-marketing/dry-run'

const fixtures = {
	'coding-workflow': codingWorkflowFixture,
	support: supportFixture,
	restricted: restrictedFixture,
} as const

const fixtureName = (process.argv[2] ??
	'coding-workflow') as keyof typeof fixtures
const fixture = fixtures[fixtureName]

if (!fixture) {
	console.error(
		`Unknown fixture "${fixtureName}". Use one of: ${Object.keys(fixtures).join(', ')}`,
	)
	process.exit(1)
}

const result = await dryRunSubscriberMarketingFixture({ fixture })
console.log(JSON.stringify(result, null, 2))
