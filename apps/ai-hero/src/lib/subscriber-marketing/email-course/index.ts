export { EmailCourseService } from "./ports";
export { advanceEmailCourse, createAdvanceEmailCourse } from "./service";
export type { AdvanceEmailCourseDependencies } from "./service";
export type {
  AdvanceEmailCourseCommand,
  AdvanceEmailCourseResult,
  DeliverDueCourseEmailsCommand,
  DeliveryBatchResult,
  EmailCourseCommandError,
  EmailCourseDeliveryError,
  EmailCourseInspection,
  EmailCourseInspectionError,
  EmailCourseQueueInspection,
  EmailCourseRunInspection,
  InspectEmailCourseQuery,
} from "./ports";
