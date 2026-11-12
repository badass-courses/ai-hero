import { NextResponse } from 'next/server'
import { db } from '@/db'
import { deviceAccessToken, deviceVerifications } from '@/db/schema'
import { LEARNER_TOKEN_TTL_MS } from '@/lib/learner-agent/identity'
import { exchangeAuthorizationCode } from '@/lib/learner-agent/oauth/grant'
import { corsPreflight, oauthError } from '@/lib/learner-agent/oauth/metadata'
import {
	DEVICE_ADMIN_SCOPE,
	deviceGrantFromCode,
	deviceOwnerAbility,
	requestedDeviceGrant,
} from '@/server/device-token-grant'
import { deviceAccessTokenForInsert } from '@/server/device-token-store'
import { and, eq, gt, isNotNull } from 'drizzle-orm'

export async function POST(request: Request) {
	const formData = await request.formData().catch(() => null)
	if (!formData)
		return oauthError(
			'invalid_request',
			'Send the token request as application/x-www-form-urlencoded (RFC 6749 section 3.2).',
		)
	if (formData.get('grant_type') === 'authorization_code')
		return exchangeAuthorizationCode(formData, request)
	return deviceCodeGrant(formData).catch(() =>
		oauthError(
			'server_error',
			'Could not issue a device token. Start device authorization again.',
			500,
		),
	)
}

export const OPTIONS = corsPreflight

async function deviceCodeGrant(formData: FormData) {
	const deviceCode = formData.get('device_code')
	const grant = deviceGrantFromCode(deviceCode)
	// Legacy UUID codes carry no authenticated consent context. Start again.
	if (!grant)
		return oauthError('invalid_grant', 'Start device authorization again.')
	const requestedClient = formData.get('client_id')
	if (
		requestedClient &&
		requestedDeviceGrant(requestedClient, null)?.clientName !== grant.clientName
	)
		return oauthError(
			'invalid_client',
			'The client does not match the device authorization.',
		)
	const requestedScope = formData.get('scope')
	if (
		requestedScope &&
		(typeof requestedScope !== 'string' ||
			[...new Set(requestedScope.trim().split(/\s+/))].join(' ') !==
				grant.scope)
	)
		return oauthError(
			'invalid_scope',
			'The scope does not match the device authorization.',
		)

	const verification = await db.query.deviceVerifications.findFirst({
		where: eq(deviceVerifications.deviceCode, deviceCode as string),
	})
	if (!verification)
		return oauthError('access_denied', 'The device code is invalid.', 403)
	if (new Date() > verification.expires)
		return oauthError(
			'expired_token',
			'The device verification has expired.',
			403,
		)
	if (!verification.verifiedAt)
		return oauthError(
			'authorization_pending',
			'The device verification is pending.',
			403,
		)
	if (!verification.verifiedByUserId)
		return oauthError('access_denied', 'No approving user.', 403)
	const ability = await deviceOwnerAbility(verification.verifiedByUserId)
	if (
		!ability ||
		(grant.scope === DEVICE_ADMIN_SCOPE && !ability.can('manage', 'all'))
	)
		return oauthError(
			'access_denied',
			'The approving user cannot grant this scope.',
			403,
		)

	// Claim before minting: simultaneous polls cannot issue multiple tokens.
	// A failed insert consumes the grant too; the caller starts a fresh flow.
	const claimed = await db
		.delete(deviceVerifications)
		.where(
			and(
				eq(deviceVerifications.deviceCode, verification.deviceCode),
				eq(deviceVerifications.verifiedByUserId, verification.verifiedByUserId),
				isNotNull(deviceVerifications.verifiedAt),
				gt(deviceVerifications.expires, new Date()),
			),
		)
	if (claimed.rowsAffected !== 1)
		return oauthError(
			'invalid_grant',
			'The device code was already used or expired.',
		)

	const token = crypto.randomUUID()
	await db.insert(deviceAccessTokenForInsert).values({
		userId: verification.verifiedByUserId,
		token,
		clientName: grant.clientName,
		scope: grant.scope,
		expiresAt: new Date(Date.now() + LEARNER_TOKEN_TTL_MS),
		revokedAt: null,
	})
	const stored = await db.query.deviceAccessToken.findFirst({
		where: eq(deviceAccessToken.token, token),
	})
	if (!stored)
		return oauthError('access_denied', 'Device token not found.', 403)
	return NextResponse.json(
		{
			access_token: stored.token,
			token_type: 'bearer',
			scope: grant.scope,
			expires_in: LEARNER_TOKEN_TTL_MS / 1000,
		},
		{ headers: { 'Cache-Control': 'no-store' } },
	)
}
