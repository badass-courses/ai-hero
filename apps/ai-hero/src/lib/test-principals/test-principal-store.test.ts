import { describe, expect, it } from 'vitest'

import {
	principalKeyedTables,
	UNINDEXED_KEY_CLEANUP,
} from './test-principal-store'

describe('test principal cleanup coverage', () => {
	it('cleans every table keyed by userId or contactId, read from the schema', () => {
		const keyed = principalKeyedTables().map(
			({ name, column }) => `${name}.${column}`,
		)
		// A new keyed table joins cleanup automatically; this pin makes the
		// change visible in review instead of silent.
		expect(keyed.sort()).toMatchInlineSnapshot(`
			[
			  "AI_Account.userId",
			  "AI_Comment.userId",
			  "AI_CommunicationPreference.userId",
			  "AI_Contact.userId",
			  "AI_ContactEvent.contactId",
			  "AI_ContactLink.contactId",
			  "AI_ContactLink.userId",
			  "AI_ContactState.contactId",
			  "AI_ContentContribution.userId",
			  "AI_ContentRead.contactId",
			  "AI_ContentRead.userId",
			  "AI_DeviceAccessToken.userId",
			  "AI_Entitlement.userId",
			  "AI_GoogleAdsSignupConversionUpload.contactId",
			  "AI_MerchantCharge.userId",
			  "AI_MerchantCustomer.userId",
			  "AI_NextAction.contactId",
			  "AI_OrganizationMembership.userId",
			  "AI_PersonalAccessToken.userId",
			  "AI_Profile.userId",
			  "AI_ProviderIdentity.contactId",
			  "AI_Purchase.userId",
			  "AI_QuestionResponse.userId",
			  "AI_ResourceProgress.userId",
			  "AI_Session.userId",
			  "AI_ShortlinkAttribution.userId",
			  "AI_SideEffectIntent.contactId",
			  "AI_StateTransition.contactId",
			  "AI_UserPermission.userId",
			  "AI_UserPrefs.userId",
			  "AI_UserRole.userId",
			  "AI_ValuePathCertificateShare.contactId",
			]
		`)
	})
})

describe('test principal cleanup cost', () => {
	it('deletes only on index-backed keys, or has an explicit plan for the column', () => {
		const unindexed = principalKeyedTables()
			.filter(({ indexed }) => !indexed)
			.map(({ name, column }) => `${name}.${column}`)
			.sort()
		// Mirrors prod (information_schema, 2026-09-25). A new unindexed key
		// must get an index or a plan: a scan inside cleanup can take seconds.
		expect(unindexed).toEqual(Object.keys(UNINDEXED_KEY_CLEANUP).sort())
	})
})
