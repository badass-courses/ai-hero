import { courseOutline } from './capabilities/course-outline.js'
import { myCourses } from './capabilities/my-courses.js'
import { officeHours } from './capabilities/office-hours.js'
import { readLesson } from './capabilities/read-lesson.js'
import { searchCourse } from './capabilities/search-course.js'
import { sessionExtract } from './capabilities/session-extract.js'

/**
 * Every learner capability, in the order agents see them. The order is
 * public: it is the tools/list order and the recommended path through a
 * course.
 */
export const capabilities = [
	myCourses,
	courseOutline,
	readLesson,
	sessionExtract,
	searchCourse,
	officeHours,
] as const

export type LearnerCapabilities = typeof capabilities
