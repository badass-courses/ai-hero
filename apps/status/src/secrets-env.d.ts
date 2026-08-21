interface Env {
  ADMIN_BEARER_TOKEN?: string;
  DETECTOR_HMAC_SECRET?: string;
  TRACER_BEARER_TOKEN?: string;
}

declare namespace Cloudflare {
  interface Env {
    ADMIN_BEARER_TOKEN: string;
    DETECTOR_HMAC_SECRET: string;
    TRACER_BEARER_TOKEN: string;
  }
}
