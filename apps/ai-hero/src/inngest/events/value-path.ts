export const VALUE_PATH_ANSWER_SELECTED_EVENT = 'value-path/answer.selected'

export type ValuePathAnswerSelected = {
	name: typeof VALUE_PATH_ANSWER_SELECTED_EVENT
	data: {
		contactId: string
		valuePathSlug: string
		sentEmailResourceId: string
		answerPageId: string
		contactEventId: string
	}
}
