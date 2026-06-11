import { normalizeContactEvent } from './normalize-contact-event'
import { normalizeFrontQuickQuestionInput } from './quick-question-normalizer'
import { captureNormalizedContactEvent } from './capture-contact-event'
import type { CaptureMarketingRepository } from './capture-contact-event'
import type { FrontQuickQuestionInput } from './quick-question-normalizer'

export async function captureFrontQuickQuestion(args: {
	repository: CaptureMarketingRepository
	input: FrontQuickQuestionInput
	now?: string
}) {
	const fixtureInput = normalizeFrontQuickQuestionInput(args.input)
	const event = normalizeContactEvent(fixtureInput)
	return captureNormalizedContactEvent({
		repository: args.repository,
		event,
		now: args.now,
	})
}
