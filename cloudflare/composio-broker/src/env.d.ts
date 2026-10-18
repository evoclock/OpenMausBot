// Secrets the Worker runs without: each one's route answers 503 or 404 until the owner sets it
// (README, "App events"). Not in wrangler.jsonc's secrets.required, which would refuse a deploy without them.
interface Env {
  COMPOSIO_WEBHOOK_SECRET?: string;
  CLOUD_GRANT_SECRET?: string;
  STATS_TOKEN?: string;
}
