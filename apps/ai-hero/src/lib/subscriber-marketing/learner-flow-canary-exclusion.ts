import { sql, type SQLWrapper } from 'drizzle-orm'

export const LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX = 'canary-learner-v1-'
export const LEARNER_FLOW_CANARY_EMAIL_PREFIX = `joel+aih-synth-${LEARNER_FLOW_CANARY_FIXTURE_ID_PREFIX}`
export const LEARNER_FLOW_CANARY_EMAIL_DOMAIN = 'badass.dev'
const LEARNER_FLOW_CANARY_EMAIL_SQL_PATTERN = `${LEARNER_FLOW_CANARY_EMAIL_PREFIX}%@${LEARNER_FLOW_CANARY_EMAIL_DOMAIN}`

export function isLearnerFlowCanaryEmail(value?: string | null) {
	const normalized = value?.trim().toLowerCase()
	if (!normalized?.startsWith(LEARNER_FLOW_CANARY_EMAIL_PREFIX)) return false
	const domain = `@${LEARNER_FLOW_CANARY_EMAIL_DOMAIN}`
	if (!normalized.endsWith(domain)) return false
	const generation = normalized.slice(LEARNER_FLOW_CANARY_EMAIL_PREFIX.length, -domain.length)
	return /^[a-z0-9-]+$/.test(generation)
}

export function learnerFlowCanaryEmailSql(email: SQLWrapper) {
	return sql`COALESCE(LOWER(TRIM(${email})), '') LIKE ${LEARNER_FLOW_CANARY_EMAIL_SQL_PATTERN}`
}

/**
 * The one business-metric exclusion for the canary namespace.
 *
 * Use the joined Contact email when it is already available. Otherwise pass a
 * contact id column and this emits a correlated exclusion against AI_Contact.
 */
export function excludeLearnerFlowCanary(input: { contactId?: SQLWrapper; email?: SQLWrapper }) {
	if (input.email) {
		return sql`NOT (${learnerFlowCanaryEmailSql(input.email)})`
	}
	if (input.contactId) {
		return sql`NOT EXISTS (
			SELECT 1
			FROM AI_Contact AS learner_flow_canary_contact
			WHERE learner_flow_canary_contact.id = ${input.contactId}
				AND ${learnerFlowCanaryEmailSql(sql.raw('learner_flow_canary_contact.email'))}
		)`
	}
	throw new Error('Canary exclusion requires a contact id or email column')
}
