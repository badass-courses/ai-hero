/**
 * Gives every user without an organization membership their personal
 * organization.
 *
 * From the core-3 deploy (2026-09-18) until the Course Builder config routed
 * `createUser` through the personal-org boundary, newsletter signups were
 * persisted as bare user rows. Signed in, such a user is sent from every
 * org-aware page to an empty `/organization-list`.
 *
 * Provisioning goes through the app's single policy instance, the same call
 * a new sign-in makes, and is idempotent.
 *
 * Usage (from `apps/ai-hero`):
 *   dotenv tsx src/scripts/personal-organizations-repair-missing.ts --dry-run
 *   DATABASE_POOL_SIZE=8 dotenv tsx src/scripts/personal-organizations-repair-missing.ts --allow-write
 *   dotenv tsx src/scripts/personal-organizations-repair-missing.ts --allow-write --email someone@example.com
 */
import { closeDatabasePool, db } from '@/db'
import { organizationMemberships, users } from '@/db/schema'
import { personalOrganizations } from '@/server/personal-organizations'
import { and, asc, eq, gt, isNull } from 'drizzle-orm'

const PAGE_SIZE = 500
const WRITE_CONCURRENCY = Math.max(
	1,
	Number(process.env.DATABASE_POOL_SIZE) || 1,
)

const args = process.argv.slice(2)
const allowWrite = args.includes('--allow-write')
const emailIndex = args.indexOf('--email')
const onlyEmail = emailIndex === -1 ? undefined : args[emailIndex + 1]

if (!allowWrite && !args.includes('--dry-run')) {
	console.error('Pass --dry-run or --allow-write')
	process.exit(1)
}

async function main() {
	let cursor = ''
	let found = 0
	let repaired = 0
	let failed = 0

	while (true) {
		const page = await db
			.select({ id: users.id, email: users.email })
			.from(users)
			.leftJoin(
				organizationMemberships,
				eq(organizationMemberships.userId, users.id),
			)
			.where(
				and(
					isNull(organizationMemberships.id),
					gt(users.id, cursor),
					onlyEmail ? eq(users.email, onlyEmail) : undefined,
				),
			)
			.orderBy(asc(users.id))
			.limit(PAGE_SIZE)

		if (page.length === 0) break
		cursor = page[page.length - 1]!.id
		found += page.length

		if (allowWrite) {
			for (let i = 0; i < page.length; i += WRITE_CONCURRENCY) {
				await Promise.all(
					page.slice(i, i + WRITE_CONCURRENCY).map(async (user) => {
						try {
							await personalOrganizations.ensurePersonalOrganization(user)
							repaired++
						} catch (error) {
							failed++
							console.error(`failed ${user.id}`, error)
						}
					}),
				)
			}
		}
		console.log(`users without an organization: ${found}, repaired: ${repaired}`)
	}

	console.log(
		JSON.stringify({ mode: allowWrite ? 'allow-write' : 'dry-run', found, repaired, failed }),
	)
}

main()
	.catch((error) => {
		console.error(error)
		process.exitCode = 1
	})
	.finally(() => closeDatabasePool())
