// The Admin's signed requests to a Cloud home. They run before the session gate: the signature is the credential. Never
// log their headers, bodies or codes. A bad pairing signature counts against the pairing lockout; a health read opens
// nothing, so it has its own nonces and never locks the Admin out of pairing.
import type { IncomingMessage, ServerResponse } from "node:http";
import { CLOUD_HEALTH_PATH, CLOUD_PAIRING_PATH, createCloudPairing, createCloudRequestVerifier, readSignedBody } from "../cloud-home.ts";
import type { CloudHealth } from "../cloud-health.ts";
import { json } from "../harness/http.ts";
import { requestSource } from "../request-auth.ts";
import type { SessionRegistry } from "../sessions.ts";

export interface CloudSignedRequest { req: IncomingMessage; res: ServerResponse; url: URL; path: string; method: string }

export function createCloudSignedRoutes(deps: {
  secret: string;
  sessions: Pick<SessionRegistry, "openPairing" | "attemptAllowed" | "noteFailure" | "clearFailures">;
  health: Pick<CloudHealth, "report">;
  now?: () => number;
}) {
  const pairing = createCloudPairing({ secret: deps.secret, sessions: deps.sessions, now: deps.now });
  const healthRequests = createCloudRequestVerifier({ secret: deps.secret, now: deps.now });
  /** True when the request was one of these and has been answered. */
  return async ({ req, res, url, path, method }: CloudSignedRequest): Promise<boolean> => {
    if (path !== CLOUD_PAIRING_PATH && path !== CLOUD_HEALTH_PATH) return false;
    res.setHeader("cache-control", "no-store");
    const source = requestSource(req);
    const header = (name: string) => { const value = req.headers[name]; return typeof value === "string" ? value : undefined; };
    const signed = { timestamp: header("x-omb-cloud-timestamp"), nonce: header("x-omb-cloud-nonce"), signature: header("x-omb-cloud-signature") };
    if (path === CLOUD_HEALTH_PATH) {
      if (method !== "GET") { json(res, 405, { error: "method_not_allowed" }); return true; }
      const verdict = healthRequests.verify({ ...signed, method, target: `${path}${url.search}`, body: "" });
      if (!verdict.ok) {
        console.warn(`cloud health refused from ${source}: ${verdict.error}`);
        json(res, verdict.status, { error: verdict.error });
        return true;
      }
      json(res, 200, deps.health.report(url.searchParams.get("after")));
      return true;
    }
    if (method !== "POST") { json(res, 405, { error: "method_not_allowed" }); return true; }
    if (!/^application\/json\b/i.test(String(req.headers["content-type"] ?? ""))) {
      json(res, 415, { error: "send the pairing request as JSON (content-type: application/json)" });
      return true;
    }
    const result = pairing.handle({ ...signed, body: await readSignedBody(req), source });
    if (result.status !== 200) console.warn(`cloud pairing refused from ${source}: ${String(result.body.error)}`);
    json(res, result.status, result.body);
    return true;
  };
}
