import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import { courseBuilderCoreFunctions } from '@coursebuilder/core/inngest'

import {
	CHECKOUT_OWNER_IDENTITY_GUARD_MARKER,
	decideCheckoutOwner,
	isCheckoutSessionOwner,
	type CheckoutOwnerUser,
} from './checkout-owner-resolution'

const signedInUser: CheckoutOwnerUser = {
	id: 'user_signed_in',
	email: 'account@example.com',
}

describe('decideCheckoutOwner', () => {
	it('keeps the signed-in user canonical when the billing email matches', () => {
		expect(
			decideCheckoutOwner({
				metadataUserId: signedInUser.id,
				metadataUser: signedInUser,
				billingEmail: 'account@example.com',
			}),
		).toEqual({ source: 'metadata-user', user: signedInUser, isNewUser: false })
	})

	it('keeps the signed-in user canonical when the billing email differs', () => {
		expect(
			decideCheckoutOwner({
				metadataUserId: signedInUser.id,
				metadataUser: signedInUser,
				billingEmail: 'billing@corporate-card.example.com',
			}),
		).toEqual({ source: 'metadata-user', user: signedInUser, isNewUser: false })
	})

	it('resolves an anonymous checkout by billing email (existing account or new user)', () => {
		expect(
			decideCheckoutOwner({
				metadataUserId: null,
				metadataUser: null,
				billingEmail: 'buyer@example.com',
			}),
		).toEqual({ source: 'billing-email', email: 'buyer@example.com' })
	})

	it('falls back to the billing email when the metadata user no longer exists', () => {
		expect(
			decideCheckoutOwner({
				metadataUserId: 'user_deleted',
				metadataUser: null,
				billingEmail: 'buyer@example.com',
			}),
		).toEqual({ source: 'billing-email', email: 'buyer@example.com' })
	})

	it('rejects a loaded user that does not match metadata.userId', () => {
		expect(() =>
			decideCheckoutOwner({
				metadataUserId: 'user_other',
				metadataUser: signedInUser,
				billingEmail: 'buyer@example.com',
			}),
		).toThrow(CHECKOUT_OWNER_IDENTITY_GUARD_MARKER)
	})

	it('rejects a checkout with no owner identity at all', () => {
		expect(() =>
			decideCheckoutOwner({
				metadataUserId: null,
				metadataUser: null,
				billingEmail: null,
			}),
		).toThrow(CHECKOUT_OWNER_IDENTITY_GUARD_MARKER)
	})

	it('is deterministic across retries', () => {
		const first = decideCheckoutOwner({
			metadataUserId: signedInUser.id,
			metadataUser: signedInUser,
			billingEmail: 'billing@corporate-card.example.com',
		})
		const second = decideCheckoutOwner({
			metadataUserId: signedInUser.id,
			metadataUser: signedInUser,
			billingEmail: 'billing@corporate-card.example.com',
		})
		expect(second).toEqual(first)
	})
})

describe('isCheckoutSessionOwner', () => {
	it('routes by owner id even when the billing email differs', () => {
		expect(
			isCheckoutSessionOwner({
				purchaseUserId: signedInUser.id,
				purchaseEmail: 'billing@corporate-card.example.com',
				sessionUserId: signedInUser.id,
				sessionUserEmail: signedInUser.email,
			}),
		).toBe(true)
	})

	it('routes by email match for buyers without an id match', () => {
		expect(
			isCheckoutSessionOwner({
				purchaseUserId: 'user_temp',
				purchaseEmail: 'Buyer@Example.com',
				sessionUserId: null,
				sessionUserEmail: 'buyer@example.com',
			}),
		).toBe(true)
	})

	it('does not route a signed-in non-owner', () => {
		expect(
			isCheckoutSessionOwner({
				purchaseUserId: 'user_owner',
				purchaseEmail: 'owner@example.com',
				sessionUserId: 'user_other',
				sessionUserEmail: 'other@example.com',
			}),
		).toBe(false)
	})

	it('does not route a signed-out viewer', () => {
		expect(
			isCheckoutSessionOwner({
				purchaseUserId: 'user_owner',
				purchaseEmail: 'owner@example.com',
				sessionUserId: null,
				sessionUserEmail: null,
			}),
		).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// Contract: the installed @coursebuilder/core build carries the owner guard.
// ---------------------------------------------------------------------------

function expectOwnerGuardBeforeBillingEmailLookup(source: string) {
	const markerIndex = source.indexOf(CHECKOUT_OWNER_IDENTITY_GUARD_MARKER)
	expect(markerIndex).toBeGreaterThanOrEqual(0)

	const findOrCreateIndex = source.indexOf('.findOrCreateUser(', markerIndex)
	expect(findOrCreateIndex).toBeGreaterThan(markerIndex)

	const guardedStep = source.slice(markerIndex, findOrCreateIndex)
	expect(guardedStep).toContain('getUserById')
}

async function loadCorePackage() {
	const require = createRequire(import.meta.url)
	// The package does not export ./package.json, so resolve a real file inside
	// it and walk up to the nearest package.json.
	let directory = dirname(require.resolve('@coursebuilder/core/inngest'))
	while (true) {
		try {
			const source = await readFile(join(directory, 'package.json'), 'utf8')
			return { directory, value: JSON.parse(source) as unknown }
		} catch {
			const parent = dirname(directory)
			if (parent === directory) {
				throw new Error('Unable to resolve core package.json')
			}
			directory = parent
		}
	}
}

function readInngestImportExport(packageJson: unknown) {
	if (typeof packageJson !== 'object' || packageJson === null) {
		throw new Error('Core package.json must be an object')
	}
	const exportsField = Reflect.get(packageJson, 'exports')
	if (typeof exportsField !== 'object' || exportsField === null) {
		throw new Error('Core package.json must define exports')
	}
	const inngestExport = Reflect.get(exportsField, './inngest')
	if (typeof inngestExport !== 'object' || inngestExport === null) {
		throw new Error('Core package.json must define an ./inngest export')
	}
	const importPath = Reflect.get(inngestExport, 'import')
	if (typeof importPath !== 'string') {
		throw new Error('Core ./inngest export must define an import path')
	}
	return importPath
}

async function readEsmGuardChunk(packageJson: {
	directory: string
	value: unknown
}) {
	const entryPath = resolve(
		packageJson.directory,
		readInngestImportExport(packageJson.value),
	)
	const entryUrl = pathToFileURL(entryPath)
	const entrySource = await readFile(entryPath, 'utf8')
	const relativeImports = [
		...entrySource.matchAll(/(?:from\s+|import\s+)["'](\.\.?\/[^"']+)["']/g),
	].flatMap((match) => (match[1] ? [match[1]] : []))
	const importedSources = await Promise.all(
		[...new Set(relativeImports)].map(async (specifier) =>
			readFile(fileURLToPath(new URL(specifier, entryUrl)), 'utf8'),
		),
	)
	const guardChunks = [entrySource, ...importedSources].filter((source) =>
		source.includes(CHECKOUT_OWNER_IDENTITY_GUARD_MARKER),
	)

	expect(guardChunks).toHaveLength(1)
	return guardChunks[0]!
}

describe('checkout owner guard in production artifacts', () => {
	it('keeps the guard before the billing-email lookup in the ESM and CJS builds', async () => {
		const packageJson = await loadCorePackage()

		const esmGuardChunk = await readEsmGuardChunk(packageJson)
		const cjsInngestSource = await readFile(
			join(packageJson.directory, 'dist/inngest/index.cjs'),
			'utf8',
		)
		const cjsSubpathSource = await readFile(
			join(
				packageJson.directory,
				'dist/inngest/stripe/event-checkout-session-completed.cjs',
			),
			'utf8',
		)

		expectOwnerGuardBeforeBillingEmailLookup(esmGuardChunk)
		expectOwnerGuardBeforeBillingEmailLookup(cjsInngestSource)
		expectOwnerGuardBeforeBillingEmailLookup(cjsSubpathSource)
	})

	it('keeps checkout completion idempotent per checkout session', () => {
		const checkoutCompleted = courseBuilderCoreFunctions.find(
			(fn) => fn.config.id === 'stripe-checkout-session-completed',
		)
		const config = checkoutCompleted?.config as
			| { id: string; idempotency?: string }
			| undefined
		expect(config?.idempotency).toBe('event.data.stripeEvent.data.object.id')
	})
})
