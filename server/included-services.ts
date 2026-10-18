// One relay URL + token pair per included service:
//   OMB_CLOUD_BOAT_URL    + OMB_CLOUD_BOAT_TOKEN     the Boat relay, ending in /api/box/v1
//   OMB_CLOUD_VOICE_URL   + OMB_CLOUD_VOICE_TOKEN    the ElevenLabs relay, ending in /v1
//   OMB_CLOUD_DECIDER_URL + OMB_CLOUD_DECIDER_TOKEN  the Jev relay, a Jev base URL
//   OMB_CLOUD_AI_URL      + OMB_CLOUD_AI_TOKEN       the trial's Claude credit, an OpenAI-compatible base URL
// The person's own key always wins and is resolved per request; an included token goes only to its relay and is never
// written to config.json or reported to a client.
import { JEV_DEFAULT_BASE_URL } from "./decider/jev.ts";

export const BOAT_API_DEFAULT = "https://boat.dev/api/v1";
export const ELEVENLABS_API_DEFAULT = "https://api.elevenlabs.io/v1";
/** Must also be on WORKSPACE_CREDENTIAL_ENV. */
export const INCLUDED_TOKEN_ENV = ["OMB_CLOUD_BOAT_TOKEN", "OMB_CLOUD_VOICE_TOKEN", "OMB_CLOUD_DECIDER_TOKEN", "OMB_CLOUD_AI_TOKEN"] as const;

export interface ServiceCredential {
  token: string;
  /** The only base URL this token is ever sent to. */
  api: string;
  included: boolean;
}

interface Included {
  boat: ServiceCredential | null;
  voice: ServiceCredential | null;
  decider: ServiceCredential | null;
  ai: ServiceCredential | null;
}

function includedService(url: string | undefined, token: string | undefined): ServiceCredential | null {
  const api = url?.trim().replace(/\/+$/, "");
  const secret = token?.trim();
  return api && secret ? { token: secret, api, included: true } : null;
}

const includedFrom = (env: NodeJS.ProcessEnv): Included => ({
  boat: includedService(env.OMB_CLOUD_BOAT_URL, env.OMB_CLOUD_BOAT_TOKEN),
  voice: includedService(env.OMB_CLOUD_VOICE_URL, env.OMB_CLOUD_VOICE_TOKEN),
  decider: includedService(env.OMB_CLOUD_DECIDER_URL, env.OMB_CLOUD_DECIDER_TOKEN),
  ai: trialCreditService(env.OMB_CLOUD_AI_URL, env.OMB_CLOUD_AI_TOKEN),
});

/** The token is a key the chat engine sends here, so the address must be HTTPS (loopback for tests) and the token the Admin's shape. */
function trialCreditService(url: string | undefined, token: string | undefined): ServiceCredential | null {
  const credential = includedService(url, token);
  if (!credential || !/^omb_ai_[A-Za-z0-9_-]{43}$/.test(credential.token)) return null;
  try {
    const parsed = new URL(credential.api);
    const loopback = parsed.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(parsed.hostname);
    return (parsed.protocol === "https:" || loopback) && !parsed.username && !parsed.password && !parsed.search && !parsed.hash ? credential : null;
  } catch {
    return null;
  }
}

let held: Included | null = null;

/** Dropped from the environment at startup so nothing the server starts can inherit them. */
export function holdIncludedServices(env: NodeJS.ProcessEnv = process.env): void {
  held = includedFrom(env);
  for (const name of INCLUDED_TOKEN_ENV) delete env[name];
}

function resolve(own: string | undefined, providerApi: string, included: ServiceCredential | null): ServiceCredential | null {
  if (own) {
    // A leased computer hands the included token back as a plain one; it still goes only to its relay.
    if (included && own === included.token) return included;
    return { token: own, api: providerApi, included: false };
  }
  return included;
}

export const boatProviderApi = (env: NodeJS.ProcessEnv = process.env): string => env.OMB_BOAT_API || BOAT_API_DEFAULT;
export const elevenLabsProviderApi = (env: NodeJS.ProcessEnv = process.env): string =>
  env.OMB_ELEVENLABS_API || ELEVENLABS_API_DEFAULT;

export function boatCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, boatProviderApi(env), (held ?? includedFrom(env)).boat);
}

export function voiceCredential(own: string | undefined, env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return resolve(own, elevenLabsProviderApi(env), (held ?? includedFrom(env)).voice);
}

export function trialCreditCredential(env: NodeJS.ProcessEnv = process.env): ServiceCredential | null {
  return (held ?? includedFrom(env)).ai;
}

export function deciderCredential(
  own: string | undefined,
  ownBaseUrl: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ServiceCredential | null {
  return resolve(own?.trim(), ownBaseUrl?.trim() || JEV_DEFAULT_BASE_URL, (held ?? includedFrom(env)).decider);
}
