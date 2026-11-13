import { createHash } from 'node:crypto'
import { getAbility, UserSchema } from '@/ability'
import { db } from '@/db'
import { users } from '@/db/schema'
import { LEARNER_READ_SCOPE } from '@/lib/learner-agent/identity'
import { seal, unseal } from '@/lib/learner-agent/oauth/sealed'
import { eq } from 'drizzle-orm'

export const DEVICE_ADMIN_SCOPE = 'admin:all'
export const DEVICE_CLI_CLIENT = 'aihero-cli'
export const DEVICE_LEARNER_CLIENT = 'learner-device'
const PREFIX = 'aih_dev_'

export type DeviceGrant = {
	clientName: typeof DEVICE_CLI_CLIENT | typeof DEVICE_LEARNER_CLIENT
	scope: typeof LEARNER_READ_SCOPE | typeof DEVICE_ADMIN_SCOPE
}

/** Client ids are public labels. Only the approving user's role grants access. */
export function requestedDeviceGrant(
	clientId: unknown,
	scope: unknown,
): DeviceGrant | null {
	const clientName =
		clientId === DEVICE_CLI_CLIENT ? DEVICE_CLI_CLIENT : DEVICE_LEARNER_CLIENT
	const scopes =
		typeof scope === 'string'
			? [...new Set(scope.trim().split(/\s+/).filter(Boolean))]
			: []
	if (
		!scopes.length ||
		(scopes.length === 1 && scopes[0] === LEARNER_READ_SCOPE)
	)
		return { clientName, scope: LEARNER_READ_SCOPE }
	if (
		clientName === DEVICE_CLI_CLIENT &&
		scopes.length === 1 &&
		scopes[0] === DEVICE_ADMIN_SCOPE
	)
		return { clientName, scope: DEVICE_ADMIN_SCOPE }
	return null
}

/** The authenticated device code binds the scope shown at approval to exchange. */
export function mintDeviceCode(grant: DeviceGrant): string | null {
	const value = seal('device', { c: grant.clientName, s: grant.scope })
	const code = value ? `${PREFIX}${value}` : null
	return code && code.length <= 191 ? code : null
}

export function deviceGrantFromCode(code: unknown): DeviceGrant | null {
	if (typeof code !== 'string' || code.length > 191 || !code.startsWith(PREFIX))
		return null
	const value = unseal('device', code.slice(PREFIX.length)) as {
		c?: unknown
		s?: unknown
	} | null
	if (
		!value ||
		(value.c !== DEVICE_CLI_CLIENT && value.c !== DEVICE_LEARNER_CLIENT)
	)
		return null
	if (value.s !== LEARNER_READ_SCOPE && value.s !== DEVICE_ADMIN_SCOPE)
		return null
	return requestedDeviceGrant(value.c, value.s)
}

const deviceCodeDigest = (code: string) =>
	createHash('sha256').update(code).digest('hex')

/** Browser consent names a grant without revealing the device's polling secret. */
export function mintDeviceConsent(
	userCode: string,
	deviceCode: string,
	userId: string,
): string | null {
	const grant = deviceGrantFromCode(deviceCode)
	if (!grant) return null
	return seal('device-consent', {
		u: userCode,
		d: deviceCodeDigest(deviceCode),
		c: grant.clientName,
		s: grant.scope,
		a: userId,
	})
}

export function matchesDeviceConsent(
	consent: string,
	userCode: string,
	deviceCode: string,
	userId: string,
): boolean {
	const grant = deviceGrantFromCode(deviceCode)
	const value = unseal('device-consent', consent) as Record<
		string,
		unknown
	> | null
	return (
		!!grant &&
		!!value &&
		value.u === userCode &&
		value.d === deviceCodeDigest(deviceCode) &&
		value.c === grant.clientName &&
		value.s === grant.scope &&
		value.a === userId
	)
}

export async function deviceOwnerAbility(userId: string) {
	const user = await db.query.users.findFirst({
		where: eq(users.id, userId),
		with: { roles: { with: { role: true } } },
	})
	if (!user) return null
	const parsed = UserSchema.safeParse({
		...user,
		roles: user.roles.map(({ role }) => role),
	})
	return parsed.success ? getAbility({ user: parsed.data }) : null
}
