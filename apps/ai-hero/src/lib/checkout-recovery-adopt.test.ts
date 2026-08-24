import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
	CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER,
	decideCheckoutRecoveryChargeAdoption,
	type CheckoutRecoveryChargeIdentity,
} from './checkout-recovery-adopt'

const incoming: CheckoutRecoveryChargeIdentity = {
	stripeChargeId: 'ch_recovery',
	userId: 'user_recovery',
	merchantAccountId: 'ma_recovery',
	merchantProductId: 'mp_recovery',
	merchantCustomerId: 'mcu_recovery',
}

const existingCharge = {
	id: 'mc_recovery',
	identifier: incoming.stripeChargeId,
	userId: incoming.userId,
	merchantAccountId: incoming.merchantAccountId,
	merchantProductId: incoming.merchantProductId,
	merchantCustomerId: incoming.merchantCustomerId,
}

function expectIdentityGuardBeforePurchaseLookup(source: string) {
	const markerIndex = source.indexOf(
		CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER,
	)
	const purchaseLookupIndex = source.indexOf(
		'existingPurchaseForCharge',
		markerIndex + CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER.length,
	)

	expect(markerIndex).toBeGreaterThanOrEqual(0)
	expect(purchaseLookupIndex).toBeGreaterThan(markerIndex)
}

async function findPackageJson(startPath: string) {
	let directory = dirname(startPath)
	while (true) {
		try {
			const source = await readFile(join(directory, 'package.json'), 'utf8')
			return { directory, value: JSON.parse(source) as unknown }
		} catch {
			const parent = dirname(directory)
			if (parent === directory) {
				throw new Error('Unable to resolve adapter package.json')
			}
			directory = parent
		}
	}
}

function readRootImportExport(packageJson: unknown) {
	if (typeof packageJson !== 'object' || packageJson === null) {
		throw new Error('Adapter package.json must be an object')
	}
	const exportsField = Reflect.get(packageJson, 'exports')
	if (typeof exportsField !== 'object' || exportsField === null) {
		throw new Error('Adapter package.json must define exports')
	}
	const rootExport = Reflect.get(exportsField, '.')
	if (typeof rootExport !== 'object' || rootExport === null) {
		throw new Error('Adapter package.json must define a root export')
	}
	const importPath = Reflect.get(rootExport, 'import')
	if (typeof importPath !== 'string') {
		throw new Error('Adapter root export must define an import path')
	}
	return importPath
}

async function readProductionEsmGuardChunk(cjsPackageEntry: string) {
	const packageJson = await findPackageJson(cjsPackageEntry)
	const entryPath = resolve(
		packageJson.directory,
		readRootImportExport(packageJson.value),
	)
	const entryUrl = pathToFileURL(entryPath)
	const entrySource = await readFile(entryPath, 'utf8')
	const relativeImports = [
		...entrySource.matchAll(/(?:from\s+|import\s+)["'](\.\/[^"']+)["']/g),
	].flatMap((match) => (match[1] ? [match[1]] : []))
	const importedSources = await Promise.all(
		[...new Set(relativeImports)].map(async (specifier) => ({
			source: await readFile(fileURLToPath(new URL(specifier, entryUrl)), 'utf8'),
			specifier,
		})),
	)
	const guardChunks = importedSources.filter(({ source }) =>
		source.includes(CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER),
	)

	expect(relativeImports.length).toBeGreaterThan(0)
	expect(guardChunks).toHaveLength(1)
	return guardChunks[0]!.source
}

describe('checkout recovery charge adoption', () => {
	it('creates when no charge exists and adopts a matching charge', () => {
		expect(
			decideCheckoutRecoveryChargeAdoption({
				existingCharge: null,
				existingPurchaseId: null,
				incoming,
			}),
		).toEqual({ action: 'create-charge' })

		expect(
			decideCheckoutRecoveryChargeAdoption({
				existingCharge,
				existingPurchaseId: null,
				incoming,
			}),
		).toEqual({ action: 'adopt-charge', merchantChargeId: 'mc_recovery' })
	})

	it('returns an existing Purchase only after identity matches', () => {
		expect(
			decideCheckoutRecoveryChargeAdoption({
				existingCharge,
				existingPurchaseId: 'purch_recovery',
				incoming,
			}),
		).toEqual({
			action: 'return-purchase',
			merchantChargeId: 'mc_recovery',
			purchaseId: 'purch_recovery',
		})
	})

	it.each([
		['identifier', 'ch_other'],
		['userId', 'user_other'],
		['merchantAccountId', 'ma_other'],
		['merchantProductId', 'mp_other'],
		['merchantCustomerId', 'mcu_other'],
	] as const)('rejects a mismatched %s before adoption', (key, value) => {
		expect(() =>
			decideCheckoutRecoveryChargeAdoption({
				existingCharge: { ...existingCharge, [key]: value },
				existingPurchaseId: null,
				incoming,
			}),
		).toThrow(CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER)
	})

	it('rejects a mismatch before returning an existing Purchase', () => {
		expect(() =>
			decideCheckoutRecoveryChargeAdoption({
				existingCharge: { ...existingCharge, userId: 'user_other' },
				existingPurchaseId: 'purch_other',
				incoming,
			}),
		).toThrow(CHECKOUT_RECOVERY_CHARGE_IDENTITY_GUARD_MARKER)
	})

	it('keeps the identity guard before the Purchase lookup in production artifacts', async () => {
		const require = createRequire(import.meta.url)
		const cjsMysqlEntry = require.resolve('@coursebuilder/adapter-drizzle/mysql')
		const esmGuardChunk = await readProductionEsmGuardChunk(cjsMysqlEntry)
		const cjsMysqlSource = await readFile(cjsMysqlEntry, 'utf8')

		expectIdentityGuardBeforePurchaseLookup(esmGuardChunk)
		expectIdentityGuardBeforePurchaseLookup(cjsMysqlSource)
	})
})
