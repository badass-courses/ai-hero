import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { Client } from '@planetscale/database'

import {
	DISCORD_LEGEND_ROLE_ID,
	DISCORD_LEGEND_ROLE_NAME,
	LEGEND_ENTITLEMENT_SOURCE_ID,
} from '../src/lib/discord-legend.ts'

type EligibleUser = {
	userId: string
	name: string
	email: string
	discordAccountIds: string[]
}

type BackfillRow = {
	userId: string
	name: string
	email: string
	discordAccounts: string
	entitlementStatus: string
	assignmentStatus: string
}

const ENV_CANDIDATES = ['.env.local', '.env.vercel', '.env.development']
const DUPLICATE_ACCOUNT_OVERRIDES: Record<string, string[]> = {
	'john.harnett@gmail.com': ['1073260223319527595', '1188860677809504307'],
	'rajatkumartx@gmail.com': ['854397973202468864'],
	'scrajusam@gmail.com': ['1247451712726241461', '268796964215193601'],
}

const loadEnvFile = () => {
	for (const candidate of ENV_CANDIDATES) {
		const filePath = path.join(process.cwd(), candidate)
		if (fs.existsSync(filePath)) {
			return fs.readFileSync(filePath, 'utf8')
		}
	}

	throw new Error(`No env file found. Checked: ${ENV_CANDIDATES.join(', ')}`)
}

const envText = loadEnvFile()
const readEnv = (name: string) => {
	const match = envText.match(new RegExp(`^${name}=(.*)$`, 'm'))
	if (!match?.[1]) {
		throw new Error(`${name} not found in env file`)
	}
	return match[1].trim().replace(/^"|"$/g, '')
}

const databaseUrl = readEnv('DATABASE_URL')
const discordBotToken = readEnv('DISCORD_BOT_TOKEN')
const discordGuildId = readEnv('DISCORD_GUILD_ID')

const client = new Client({ url: databaseUrl })
const conn = client.connection()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const fetchDiscord = async (
	endpoint: string,
	init?: RequestInit,
	attempt = 0,
): Promise<{ response: Response; json: any }> => {
	const response = await fetch(`https://discord.com/api/${endpoint}`, {
		...init,
		headers: {
			Authorization: `Bot ${discordBotToken}`,
			'Content-Type': 'application/json',
			...(init?.headers ?? {}),
		},
	})

	const text = await response.text()
	const json = text ? JSON.parse(text) : null

	if (response.status === 429 && attempt < 5) {
		const retryAfterMs = Math.ceil(Number(json?.retry_after ?? 1) * 1000) + 250
		await sleep(retryAfterMs)
		return fetchDiscord(endpoint, init, attempt + 1)
	}

	return { response, json }
}

const getGuildRoles = async () => {
	const { response, json } = await fetchDiscord(
		`guilds/${discordGuildId}/roles`,
	)
	if (!response.ok || !Array.isArray(json)) {
		throw new Error(`Failed to load Discord roles: ${response.status}`)
	}
	return json as Array<{ id: string; name: string }>
}

const getSelectedDiscordAccountIds = (user: EligibleUser) => {
	if (user.discordAccountIds.length <= 1) return user.discordAccountIds
	return DUPLICATE_ACCOUNT_OVERRIDES[user.email] ?? []
}

const eligibleUsersQuery = `
SELECT
  t.user_id,
  COALESCE(NULLIF(TRIM(t.name), ''), '') AS name,
  t.email,
  a.providerAccountId AS discordAccountId
FROM (
  SELECT u.id AS user_id, u.name, u.email
  FROM AI_Purchase p
  JOIN AI_User u ON u.id = p.userId
  WHERE p.productId IN ('product-3vfob', 'product-wdhub', 'product-7t9ek')
    AND p.status IN ('Valid', 'Restricted')
  GROUP BY u.id, u.name, u.email
  HAVING COUNT(DISTINCT p.productId) = 3
) t
LEFT JOIN AI_Account a ON a.userId = t.user_id AND a.provider = 'discord'
ORDER BY LOWER(COALESCE(NULLIF(TRIM(t.name), ''), t.email)) ASC, a.providerAccountId ASC
`

const entitlementTypeQuery = `
SELECT id
FROM AI_EntitlementType
WHERE name = 'cohort_discord_role'
LIMIT 1
`

const existingLegendEntitlementsQuery = `
SELECT userId
FROM AI_Entitlement
WHERE entitlementType = ?
  AND deletedAt IS NULL
  AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.discordRoleId')) = ?
GROUP BY userId
`

const insertLegendEntitlementQuery = `
INSERT INTO AI_Entitlement (
  id,
  entitlementType,
  userId,
  sourceType,
  sourceId,
  metadata,
  createdAt,
  updatedAt
) VALUES (?, ?, ?, 'MANUAL', ?, JSON_OBJECT('discordRoleId', ?), NOW(3), NOW(3))
`

const eligibleResult = await conn.execute(eligibleUsersQuery)
const rawEligibleUsers = eligibleResult.rows as Array<{
	user_id: string
	name: string
	email: string
	discordAccountId: string | null
}>

const eligibleUsersMap = new Map<string, EligibleUser>()
for (const row of rawEligibleUsers) {
	const existing = eligibleUsersMap.get(row.user_id)
	const discordAccountId = row.discordAccountId ?? ''
	if (existing) {
		if (discordAccountId) existing.discordAccountIds.push(discordAccountId)
		continue
	}

	eligibleUsersMap.set(row.user_id, {
		userId: row.user_id,
		name: row.name,
		email: row.email,
		discordAccountIds: discordAccountId ? [discordAccountId] : [],
	})
}

const eligibleUsers = Array.from(eligibleUsersMap.values())

const entitlementTypeResult = await conn.execute(entitlementTypeQuery)
const cohortDiscordRoleEntitlementTypeId = entitlementTypeResult.rows?.[0]?.id
if (!cohortDiscordRoleEntitlementTypeId) {
	throw new Error('cohort_discord_role entitlement type not found')
}

const existingEntitlementResult = await conn.execute(
	existingLegendEntitlementsQuery,
	[cohortDiscordRoleEntitlementTypeId, DISCORD_LEGEND_ROLE_ID],
)
const usersWithLegendEntitlement = new Set(
	(existingEntitlementResult.rows as Array<{ userId: string }>).map(
		(row) => row.userId,
	),
)

const guildRoles = await getGuildRoles()
const legendRole = guildRoles.find((role) => role.id === DISCORD_LEGEND_ROLE_ID)
if (!legendRole) {
	throw new Error(
		`${DISCORD_LEGEND_ROLE_NAME} role ${DISCORD_LEGEND_ROLE_ID} not found in Discord guild`,
	)
}

const results: BackfillRow[] = []
let insertedEntitlements = 0
let assignedMembers = 0
let alreadyAssignedMembers = 0
let notConnectedUsers = 0

for (const user of eligibleUsers) {
	let entitlementStatus = 'existing'
	if (!usersWithLegendEntitlement.has(user.userId)) {
		await conn.execute(insertLegendEntitlementQuery, [
			`legend-discord-${randomUUID()}`,
			cohortDiscordRoleEntitlementTypeId,
			user.userId,
			`${LEGEND_ENTITLEMENT_SOURCE_ID}-backfill-2026-03-29`,
			DISCORD_LEGEND_ROLE_ID,
		])
		usersWithLegendEntitlement.add(user.userId)
		insertedEntitlements += 1
		entitlementStatus = 'inserted'
	}

	const selectedDiscordAccounts = getSelectedDiscordAccountIds(user)
	if (selectedDiscordAccounts.length === 0) {
		notConnectedUsers += 1
		results.push({
			userId: user.userId,
			name: user.name,
			email: user.email,
			discordAccounts: '',
			entitlementStatus,
			assignmentStatus: 'not_connected',
		})
		continue
	}

	const accountStatuses: string[] = []

	for (const discordAccountId of selectedDiscordAccounts) {
		const memberResult = await fetchDiscord(
			`guilds/${discordGuildId}/members/${discordAccountId}`,
		)

		if (memberResult.response.status === 404) {
			accountStatuses.push(`${discordAccountId}:not_in_guild`)
			continue
		}

		if (!memberResult.response.ok || !memberResult.json?.user) {
			accountStatuses.push(
				`${discordAccountId}:http_${memberResult.response.status}`,
			)
			continue
		}

		const currentRoles = new Set<string>(memberResult.json.roles ?? [])
		if (currentRoles.has(DISCORD_LEGEND_ROLE_ID)) {
			alreadyAssignedMembers += 1
			accountStatuses.push(`${discordAccountId}:already_assigned`)
			continue
		}

		currentRoles.add(DISCORD_LEGEND_ROLE_ID)
		const patchResult = await fetchDiscord(
			`guilds/${discordGuildId}/members/${discordAccountId}`,
			{
				method: 'PATCH',
				body: JSON.stringify({ roles: Array.from(currentRoles) }),
			},
		)

		if (!patchResult.response.ok) {
			accountStatuses.push(
				`${discordAccountId}:patch_http_${patchResult.response.status}`,
			)
			continue
		}

		assignedMembers += 1
		accountStatuses.push(`${discordAccountId}:assigned`)
	}

	results.push({
		userId: user.userId,
		name: user.name,
		email: user.email,
		discordAccounts: selectedDiscordAccounts.join(' | '),
		entitlementStatus,
		assignmentStatus: accountStatuses.join(' | '),
	})
}

const reportPath = '/tmp/aihero-legend-role-backfill-2026-03-29.csv'
const csvHeader = Object.keys(results[0])
const csvLines = [csvHeader.join(',')]
for (const row of results) {
	csvLines.push(
		csvHeader
			.map((key) => JSON.stringify(row[key as keyof BackfillRow] ?? ''))
			.join(','),
	)
}
fs.writeFileSync(reportPath, `${csvLines.join('\n')}\n`)

console.log(
	JSON.stringify(
		{
			eligibleUsers: eligibleUsers.length,
			insertedEntitlements,
			assignedMembers,
			alreadyAssignedMembers,
			notConnectedUsers,
			legendRoleId: DISCORD_LEGEND_ROLE_ID,
			reportPath,
		},
		null,
		2,
	),
)
