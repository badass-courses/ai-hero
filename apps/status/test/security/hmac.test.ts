import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { signDetectorRequest, verifyDetectorRequest } from "../../src/security/hmac";
import { detectorEvent } from "../fixtures/detector-event";

const secret = "fixture-detector-secret";

describe("detector HMAC boundary", () => {
  it("verifies a timestamped HMAC and rejects stale or invalid signatures", async () => {
    const body = JSON.stringify(detectorEvent);
    const nowMs = Date.parse("2026-08-10T10:00:00.000Z");
    const timestamp = Math.floor(nowMs / 1000);
    const signature = await signDetectorRequest(secret, timestamp, body);
    await expect(
      verifyDetectorRequest({
        secret,
        body,
        timestampHeader: String(timestamp),
        signatureHeader: signature,
        nowMs,
      }),
    ).resolves.toEqual({ ok: true, timestampSeconds: timestamp });
    await expect(
      verifyDetectorRequest({
        secret,
        body,
        timestampHeader: String(timestamp - 301),
        signatureHeader: signature,
        nowMs,
      }),
    ).resolves.toEqual({ ok: false, code: "outside_replay_window" });
    await expect(
      verifyDetectorRequest({
        secret,
        body,
        timestampHeader: String(timestamp),
        signatureHeader: "v1=wrong",
        nowMs,
      }),
    ).resolves.toEqual({ ok: false, code: "invalid_signature" });
  });

  it("accepts a current signed event once and rejects private fields", async () => {
    const observedAt = new Date().toISOString();
    const timestamp = Math.floor(Date.parse(observedAt) / 1000);
    const current = {
      ...detectorEvent,
      eventId: "current-hmac-event",
      idempotencyKey: "current-hmac-idem",
      observedAt,
    };
    const body = JSON.stringify(current);
    const signature = await signDetectorRequest(secret, timestamp, body);
    const accepted = await SELF.fetch("https://status.test/v1/detector-events", {
      method: "POST",
      headers: { "x-aih-timestamp": String(timestamp), "x-aih-signature": signature },
      body,
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ accepted: true, replayed: false });

    const privateBody = JSON.stringify({
      ...current,
      eventId: "private-event",
      idempotencyKey: "private-idem",
      rawLog: "private",
    });
    const privateSignature = await signDetectorRequest(secret, timestamp, privateBody);
    const rejected = await SELF.fetch("https://status.test/v1/detector-events", {
      method: "POST",
      headers: { "x-aih-timestamp": String(timestamp), "x-aih-signature": privateSignature },
      body: privateBody,
    });
    expect(rejected.status).toBe(400);
    const rejectionText = await rejected.text();
    expect(JSON.parse(rejectionText)).toEqual({ error: "invalid_detector_event" });
    expect(rejectionText).not.toContain("rawLog");
    expect(rejectionText).not.toContain("private");
  });

  it("uses one generic response for signed-ingress authentication failures", async () => {
    const body = JSON.stringify(detectorEvent);
    const timestamp = Math.floor(Date.now() / 1000);
    const rejected = await SELF.fetch("https://status.test/v1/detector-events", {
      method: "POST",
      headers: {
        "x-aih-timestamp": String(timestamp),
        "x-aih-signature": "v1=wrong",
      },
      body,
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toEqual({ error: "unauthorized" });
  });
});
