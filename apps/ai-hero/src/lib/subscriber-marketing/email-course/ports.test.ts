import { describe, expectTypeOf, it } from "vitest";

import type {
  DeliverableCourseEmailIntent,
  HeldCourseEmailIntent,
} from "./domain";
import type {
  AuthorizedCourseDelivery,
  ClaimedCourseEmailIntent,
  CourseDeliveryPort,
  EmailCourseAutomationControlRepository,
  EmailCourseScheduler,
} from "./ports";

describe("email course port contracts", () => {
  it("keeps held intents outside the claim and delivery boundary", () => {
    expectTypeOf<HeldCourseEmailIntent>().not.toMatchTypeOf<DeliverableCourseEmailIntent>();
    expectTypeOf<
      ClaimedCourseEmailIntent["intent"]
    >().toEqualTypeOf<DeliverableCourseEmailIntent>();
    expectTypeOf<
      Parameters<CourseDeliveryPort["apply"]>[0]
    >().toEqualTypeOf<AuthorizedCourseDelivery>();
  });

  it("exposes fail-closed control and cadence seams", () => {
    expectTypeOf<EmailCourseAutomationControlRepository>().toHaveProperty(
      "readEffective",
    );
    expectTypeOf<EmailCourseScheduler>().toHaveProperty("nextAvailableAt");
  });
});
