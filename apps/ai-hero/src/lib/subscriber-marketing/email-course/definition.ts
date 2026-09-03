import {
  parseContentResourceId,
  parseCourseId,
  parseCoursePathId,
  parseCourseStepId,
  parseDeliveryTargetId,
  type ContentResourceId,
  type CourseId,
  type CoursePathId,
  type CourseStepId,
  type DeliveryTargetId,
  type ParseResult,
} from "./primitives";

export type EmailCourseStepDefinition = {
  readonly stepId: CourseStepId;
  readonly pathId: CoursePathId;
  readonly position: number;
  readonly contentResourceId: ContentResourceId;
  readonly deliveryTargetId: DeliveryTargetId;
  readonly defaultNextStepId: CourseStepId | null;
};

export type EmailCoursePathDefinition = {
  readonly pathId: CoursePathId;
  readonly entryStepId: CourseStepId;
  readonly steps: readonly EmailCourseStepDefinition[];
};

export type EmailCourseDefinition = {
  readonly courseId: CourseId;
  readonly version: string;
  readonly entryPathId: CoursePathId;
  readonly entryStepId: CourseStepId;
  readonly paths: readonly EmailCoursePathDefinition[];
};

function path(args: {
  pathName: "individual" | "team";
  contentPrefix: "email" | "team-email";
}): EmailCoursePathDefinition {
  const pathId = must(
    parseCoursePathId(
      args.pathName === "individual"
        ? "ai-hero-skills-workflow"
        : "ai-hero-skills-team-workflow",
    ),
    "pathId",
  );
  const steps = Array.from({ length: 8 }, (_, position) => {
    const stepId = must(
      parseCourseStepId(`${args.pathName}.email-${position}`),
      "stepId",
    );
    const nextStepId =
      position < 7
        ? must(
            parseCourseStepId(`${args.pathName}.email-${position + 1}`),
            "nextStepId",
          )
        : null;
    return {
      stepId,
      pathId,
      position,
      contentResourceId: must(
        parseContentResourceId(
          `ai-hero-skills-${args.pathName === "team" ? "team-" : ""}workflow.${args.contentPrefix}-${position}`,
        ),
        "contentResourceId",
      ),
      deliveryTargetId: must(
        parseDeliveryTargetId(
          `skills-workflow.${args.pathName}.email-${position}`,
        ),
        "deliveryTargetId",
      ),
      defaultNextStepId: nextStepId,
    } satisfies EmailCourseStepDefinition;
  });
  return {
    pathId,
    entryStepId: must(
      parseCourseStepId(`${args.pathName}.email-0`),
      "entryStepId",
    ),
    steps,
  };
}

const individualPath = path({
  pathName: "individual",
  contentPrefix: "email",
});
const teamPath = path({ pathName: "team", contentPrefix: "team-email" });

export const AI_HERO_SKILLS_WORKFLOW_COURSE_V1 = {
  courseId: must(parseCourseId("skills-workflow"), "courseId"),
  version: "skills-workflow.v1",
  entryPathId: individualPath.pathId,
  entryStepId: individualPath.entryStepId,
  paths: [individualPath, teamPath],
} as const satisfies EmailCourseDefinition;

function must<Value>(result: ParseResult<Value>, field: string): Value {
  if (result.ok) return result.value;
  throw new Error(`Invalid ${field}: ${result.error.reason}`);
}
