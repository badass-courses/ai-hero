import { Client } from '@planetscale/database'
import {
	parseWorkshopReleaseArgs,
	releaseManagedWorkshop,
	WorkshopReleaseRefused,
} from '../src/course-sync/workshop-release'

async function main() {
	const options = parseWorkshopReleaseArgs(process.argv.slice(2))
	if (!process.env.DATABASE_URL)
		throw new WorkshopReleaseRefused('DATABASE_URL is required.')
	const client = new Client({ url: process.env.DATABASE_URL })
	const receipt = await client.transaction((tx) =>
		releaseManagedWorkshop(tx, options),
	)
	// No resource content, connection details or credentials in operator output.
	console.log(JSON.stringify(receipt))
}

main().catch((error: unknown) => {
	console.error(
		error instanceof WorkshopReleaseRefused
			? error.message
			: 'Workshop release failed. Transaction aborted; inspect privately.',
	)
	process.exitCode = 1
})
