import { Schema } from "effect";
import { FakeApprovalV1 } from "./approvals/fake-approval";
import { fakeBearerIdentityAdapter } from "./auth/fake-identity";
import {
  DetectorEventV1,
  DevinInvestigationResultV1,
  decodeDetectorEvent,
  decodePublicStatus,
} from "./contracts/index";
import { IncidentStore } from "./durable-object/incident-store";
import { PRIVATE_CACHE_CONTROL, PUBLIC_CACHE_CONTROL } from "./projections/index";
import { verifyDetectorRequest } from "./security/hmac";
import { statusPage, unavailablePage } from "./ui/page";

export { IncidentStore };

const ReplayAction = Schema.Union([
  Schema.Struct({ type: Schema.Literal("event"), event: DetectorEventV1 }),
  Schema.Struct({ type: Schema.Literal("approval"), approval: FakeApprovalV1 }),
  Schema.Struct({ type: Schema.Literal("investigation"), result: DevinInvestigationResultV1 }),
]);
const ReplayRequest = Schema.Struct({
  schemaVersion: Schema.Literal("aih.status.replay.v1"),
  actions: Schema.Array(ReplayAction),
});

const json = (body: unknown, init: ResponseInit = {}): Response => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { ...init, headers });
};

const authorized = (request: Request, token: string | undefined): boolean =>
  fakeBearerIdentityAdapter.authorizeBearer({
    authorization: request.headers.get("authorization"),
    expectedToken: token,
  });

const storeStub = (env: Env): DurableObjectStub =>
  env.INCIDENTS.getByName("serialized-status-tracer");

const privateHeaders = (): HeadersInit => ({
  "cache-control": PRIVATE_CACHE_CONTROL,
});

async function storeRequest(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-automation-enabled", env.STATUS_AUTOMATION_ENABLED);
  headers.set("x-public-writes-enabled", env.STATUS_PUBLIC_WRITES_ENABLED);
  return storeStub(env).fetch(`https://status-store${path}`, { ...init, headers });
}

async function handleDetector(request: Request, env: Env): Promise<Response> {
  if (!env.DETECTOR_HMAC_SECRET) {
    return json({ error: "detector_not_configured" }, { status: 503, headers: privateHeaders() });
  }
  const body = await request.text();
  const verification = await verifyDetectorRequest({
    secret: env.DETECTOR_HMAC_SECRET,
    body,
    timestampHeader: request.headers.get("x-aih-timestamp"),
    signatureHeader: request.headers.get("x-aih-signature"),
  });
  if (!verification.ok) {
    return json({ error: "unauthorized" }, { status: 401, headers: privateHeaders() });
  }

  try {
    const event = decodeDetectorEvent(JSON.parse(body));
    if (Math.abs(Date.parse(event.observedAt) - verification.timestampSeconds * 1000) > 300_000) {
      return json({ error: "invalid_detector_event" }, { status: 400, headers: privateHeaders() });
    }
    const response = await storeRequest(env, "/event", {
      method: "POST",
      body: JSON.stringify(event),
    });
    return json(await response.json(), { status: response.status, headers: privateHeaders() });
  } catch {
    return json({ error: "invalid_detector_event" }, { status: 400, headers: privateHeaders() });
  }
}

async function handleReplay(request: Request, env: Env): Promise<Response> {
  if (env.TRACER_ENABLED !== "true") return new Response("Not found", { status: 404 });
  if (!authorized(request, env.TRACER_BEARER_TOKEN)) {
    return json({ error: "unauthorized" }, { status: 401, headers: privateHeaders() });
  }
  try {
    const replay = Schema.decodeUnknownSync(ReplayRequest, {
      errors: "all",
      onExcessProperty: "error",
    })(await request.json());
    const outcomes: unknown[] = [];
    for (const action of replay.actions) {
      const path =
        action.type === "event"
          ? "/event"
          : action.type === "approval"
            ? "/approval"
            : "/investigation";
      const payload =
        action.type === "event"
          ? action.event
          : action.type === "approval"
            ? action.approval
            : action.result;
      const response = await storeRequest(env, path, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      outcomes.push(await response.json());
    }
    const adminResponse = await storeRequest(env, "/admin");
    return json(
      { schemaVersion: "aih.status.replay-result.v1", outcomes, admin: await adminResponse.json() },
      { headers: privateHeaders() },
    );
  } catch {
    return json({ error: "invalid_replay" }, { status: 400, headers: privateHeaders() });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/v1/detector-events") {
      return handleDetector(request, env);
    }
    if (request.method === "POST" && url.pathname === "/__tracer/replay") {
      return handleReplay(request, env);
    }
    if (request.method === "GET" && url.pathname === "/admin/status.json") {
      if (!authorized(request, env.ADMIN_BEARER_TOKEN)) {
        return json({ error: "unauthorized" }, { status: 401, headers: privateHeaders() });
      }
      const response = await storeRequest(env, "/admin");
      return json(await response.json(), { status: response.status, headers: privateHeaders() });
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status.json")) {
      try {
        const response = await storeRequest(env, "/public");
        if (!response.ok) throw new Error("status store unavailable");
        const status = await response.json();
        if (url.pathname === "/status.json") {
          return json(status, {
            headers: {
              "cache-control": PUBLIC_CACHE_CONTROL,
              "x-robots-tag": "noindex, nofollow",
            },
          });
        }
        return new Response(statusPage(decodePublicStatus(status)), {
          headers: {
            "cache-control": PUBLIC_CACHE_CONTROL,
            "content-type": "text/html; charset=utf-8",
            "x-robots-tag": "noindex, nofollow",
          },
        });
      } catch {
        if (url.pathname === "/status.json") {
          return json(
            { schemaVersion: "aih.status.unavailable.v1", error: "status_temporarily_unavailable" },
            {
              status: 503,
              headers: {
                "cache-control": "public, max-age=5",
                "x-robots-tag": "noindex, nofollow",
              },
            },
          );
        }
        return new Response(unavailablePage(), {
          status: 503,
          headers: {
            "cache-control": "public, max-age=5",
            "content-type": "text/html; charset=utf-8",
            "x-robots-tag": "noindex, nofollow",
          },
        });
      }
    }
    return new Response("Not found", {
      status: 404,
      headers: { "cache-control": PRIVATE_CACHE_CONTROL },
    });
  },
};
