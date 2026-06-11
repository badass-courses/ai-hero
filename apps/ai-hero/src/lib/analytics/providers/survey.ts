import { db } from '@/db'
import {
	contentResource,
	contentResourceResource,
	questionResponse,
	users,
} from '@/db/schema'

import { createSurveyProvider } from '@coursebuilder/analytics/providers/survey'

const provider = createSurveyProvider(db, {
	contentResource,
	contentResourceResource,
	questionResponse,
	users,
})

export const {
	getSurveySummary,
	getSurveyList,
	getSurveyResponsesByDay,
	getSurveyQuestionBreakdown,
	getSurveyResponses,
} = provider
export default provider
