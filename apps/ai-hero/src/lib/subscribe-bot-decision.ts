import { SUBSCRIBE_BOT_CONFIG } from './subscribe-bot-config'

export type SubscribeBotMode = 'off' | 'shadow' | 'enforce'
export type SubscribeBotSignal = 'human' | 'bot' | 'error' | 'no-attestation'
export type SubscribeDecision =
	| { action: 'allow'; reason: 'human' | 'botid-error' | 'no-attestation' }
	| { action: 'reject'; reason: 'botid' | 'random-name' }

// Two switches, three modes: 00 -> off, 10 -> shadow, 01/11 -> enforce.
export function subscribeBotMode({
	shadow,
	enforce,
}: {
	shadow: boolean
	enforce: boolean
}): SubscribeBotMode {
	return enforce ? 'enforce' : shadow ? 'shadow' : 'off'
}

export function isRandomLookingName(firstName: unknown): boolean {
	const config = SUBSCRIBE_BOT_CONFIG.name
	return (
		typeof firstName === 'string' &&
		firstName.length >= config.minimumLength &&
		config.letters.test(firstName) &&
		(firstName.slice(1).match(config.capitals)?.length ?? 0) >=
			config.minimumInnerCapitals
	)
}

export function decideSubscribe({
	botid,
	firstName,
}: {
	botid: SubscribeBotSignal
	firstName: unknown
}): SubscribeDecision {
	if (botid === 'no-attestation')
		return { action: 'allow', reason: 'no-attestation' }
	if (botid === 'error') return { action: 'allow', reason: 'botid-error' }
	if (botid !== 'bot') return { action: 'allow', reason: 'human' }
	return {
		action: 'reject',
		reason: isRandomLookingName(firstName) ? 'random-name' : 'botid',
	}
}
