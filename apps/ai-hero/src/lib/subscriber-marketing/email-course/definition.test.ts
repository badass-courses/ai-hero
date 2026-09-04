import { describe, expect, it } from "vitest";

import { AI_HERO_SKILLS_WORKFLOW_COURSE_V1 } from "./definition";

describe("AI Hero Skills Workflow course definition", () => {
  it("owns two eight-message paths with one individual entry", () => {
    expect(AI_HERO_SKILLS_WORKFLOW_COURSE_V1).toMatchObject({
      courseId: "skills-workflow",
      version: "skills-workflow.v1",
      entryPathId: "ai-hero-skills-workflow",
      entryStepId: "individual.email-0",
    });
    expect(
      AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths.map((path) => path.pathId),
    ).toEqual(["ai-hero-skills-workflow", "ai-hero-skills-team-workflow"]);
    expect(AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths).toHaveLength(2);
    expect(
      AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths.flatMap((path) => path.steps),
    ).toHaveLength(16);
  });

  it("uses unique provider-neutral delivery targets", () => {
    const steps = AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths.flatMap(
      (path) => path.steps,
    );
    const targets = steps.map((step) => step.deliveryTargetId);
    expect(new Set(targets).size).toBe(targets.length);
    expect(targets).toEqual([
      ...Array.from(
        { length: 8 },
        (_, index) => `skills-workflow.individual.email-${index}`,
      ),
      ...Array.from(
        { length: 8 },
        (_, index) => `skills-workflow.team.email-${index}`,
      ),
    ]);
  });

  it("ends both paths at Email 7 without another default step", () => {
    for (const path of AI_HERO_SKILLS_WORKFLOW_COURSE_V1.paths) {
      expect(path.steps.at(-1)).toMatchObject({
        position: 7,
        defaultNextStepId: null,
      });
    }
  });
});
