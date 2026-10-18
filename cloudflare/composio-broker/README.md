# OpenMausBot connected-apps broker

This Worker keeps the shared Composio project key out of desktop builds. Each
installation receives a random bearer token stored only as a SHA-256 hash in
D1. The Worker gives that installation its own Composio user/session, proxies
MCP traffic, and returns short-lived Connect Links to the local app.

The desktop never receives the project key. Authorization links are returned
only on demand and are never persisted in chat messages.

Deployment for this repository:

1. `pnpm broker:types`
2. `pnpm exec wrangler d1 migrations apply openmausbot-composio --remote --config cloudflare/composio-broker/wrangler.jsonc`
3. For an existing Worker, run `pnpm exec wrangler secret put COMPOSIO_API_KEY --config cloudflare/composio-broker/wrangler.jsonc`, then `pnpm broker:deploy`.
4. For the very first deploy, put `COMPOSIO_API_KEY=...` in the ignored `.dev.vars.production` file and run `pnpm exec wrangler deploy --config cloudflare/composio-broker/wrangler.jsonc --secrets-file .dev.vars.production`. Delete the file immediately afterward.

Forks should create their own D1 database and rate-limit namespaces, replace
the IDs in `wrangler.jsonc`, deploy under their own Worker name, and set
`OMB_COMPOSIO_BROKER_URL` in their packaged build. Running only the local
server with a Composio project key remains the no-Cloudflare self-host path.

Set `REGISTRATION_MODE` to `closed` to stop issuing new installation tokens
without affecting existing users.

## App events (Composio triggers)

The broker also receives Composio trigger events for every installation and
queues them until the installation's OMB server collects them. A desktop
needs no public URL: Composio posts to the broker, the server long-polls it.

```
Composio --signed POST--> /v1/composio/webhook --> D1 queue per installation <-- GET /v1/events (25 s long-poll)
```

### Routes

| Route | Auth | Does |
| --- | --- | --- |
| `POST /v1/composio/webhook` | Composio signature (`COMPOSIO_WEBHOOK_SECRET`) | Verifies the Standard Webhooks signature (300 s tolerance), routes `metadata.trigger_id` through `trigger_bindings`, requires `metadata.user_id` to be that installation's Composio user, and queues the event. A bad, missing or stale signature gets 401; an event no installation can take gets 200 and is only counted. |
| `GET /v1/trigger-types[?toolkits=a,b]` | installation token | Event types of the given toolkits (at most 10), or of the installation's active connected accounts. Types that need their own webhook endpoint are left out. Cached per isolate for an hour. |
| `GET /v1/trigger-types/:slug` | installation token | One event type with its config and payload schemas. |
| `POST /v1/triggers` `{slug, connectedAccountId, config}` | installation token | Checks that the account is this installation's, then `POST /trigger_instances/{slug}/upsert` and saves the binding. An identical config returns the same `triggerId`, so local triggers can share one. |
| `PATCH /v1/triggers/:triggerId` `{enabled}` | installation token | Enables or disables the instance at Composio (only disabled once no other binding wants it). A config change is a new `POST` plus a `DELETE` of the old instance. |
| `DELETE /v1/triggers/:triggerId` | installation token | Removes the binding, its queued events and drop counts, and the Composio instance once nothing else binds it. Also deletes an unbound instance of this installation's Composio user. |
| `GET /v1/triggers` | installation token | Bindings beside Composio's view (`remote.state`: `enabled`, `disabled` or `missing`), `unbound` instances, drop counts per trigger, limits and today's usage: everything the server's reconciliation needs. |
| `GET /v1/events?after=<seq>&wait=<0-25>&limit=<1-50>` + header `x-omb-poller` | installation token | Acks every event at or below `after`, then returns the next events in arrival order, holding up to `wait` seconds. One poller at a time per installation: another `x-omb-poller` gets 409 until the 90 s lease runs out. |
| `POST /v1/events/test` `{triggerId, data}` | installation token | Queues a synthetic event (`type: "omb.test"`) through the same queue and limits. |
| `PUT /v1/installation/cloud` `{grant}` | installation token | Marks the installation as a paid Cloud's from an Admin-signed grant. |
| `GET /v1/stats/app-events?days=<1-90>` | `Bearer STATS_TOKEN` | Fleet totals per day (queued, delivered, duplicates, drops, expired, unrouted) and current counts. Counts only, never event contents or installation ids. |
| cron `23 * * * *` | | Expires events not collected within 7 days, disables at Composio the triggers of installations that have not polled for 14 days (re-enabled on their next poll), keeps daily counts for 90 days. |

### Limits

| | Desktop | Paid Cloud |
| --- | --- | --- |
| Events queued per UTC day | 500 | 2,000 |
| Waiting in the queue | 1,000 events or 20 MB | same |
| Event `data` stored | 64 KB, then a truncation marker with a preview | same |
| Kept when not collected | 7 days | same |

An event over a limit is answered 200 to Composio, not queued, and counted on
its trigger (`event_drops`, shown by `GET /v1/triggers`) and in the daily
counts. Status events (`composio.trigger.disabled`,
`composio.connected_account.expired`) skip the limits and carry ids only.

### Paid Clouds

Registration is open, so a Cloud proves its plan with a grant the Cloud Admin
signs. The grant is `v1.<machine id>.<signature>`, where the signature is
`base64url(HMAC-SHA256(CLOUD_GRANT_SECRET, "omb-connected-apps-cloud:v1\n" + machineId))`:

```js
import { createHmac } from "node:crypto";
const grant = `v1.${machineId}.${createHmac("sha256", CLOUD_GRANT_SECRET).update(`omb-connected-apps-cloud:v1\n${machineId}`).digest("base64url")}`;
```

The Admin sets it as the machine's `OMB_CLOUD_CONNECTED_APPS_GRANT` secret
for paid plans only. The Cloud's server presents it after registering
(`server/cloud-connected-apps.ts`). One machine id holds the Cloud limit on one
installation at a time: presenting the grant again moves it.

### One-time owner setup, in this order

1. Apply the migration before deploying the code (the old code ignores the
   new tables and columns):
   `pnpm exec wrangler d1 migrations apply openmausbot-composio --remote --config cloudflare/composio-broker/wrangler.jsonc`
2. Deploy as usual (`wrangler versions upload --preview-alias <name>`, check,
   then `wrangler versions deploy`). Until step 4 the webhook route answers
   503 and no client calls the new routes.
3. Create the project's webhook subscription. Composio allows one per
   project; check that there is none, then create it and copy the returned
   `secret`:

   ```sh
   curl -sS https://backend.composio.dev/api/v3.1/webhook_subscriptions -H "x-api-key: $COMPOSIO_API_KEY"
   curl -sS -X POST https://backend.composio.dev/api/v3.1/webhook_subscriptions \
     -H "x-api-key: $COMPOSIO_API_KEY" -H "content-type: application/json" \
     -d '{"webhook_url":"https://openmausbot-composio.milindsoni201.workers.dev/v1/composio/webhook","enabled_events":["composio.trigger.message","composio.trigger.disabled","composio.connected_account.expired"],"version":"V3"}'
   ```

   If Composio refuses `composio.trigger.disabled`, leave it out: the server's
   reconciliation still sees a disabled trigger through `GET /v1/triggers`.
4. `pnpm exec wrangler secret put COMPOSIO_WEBHOOK_SECRET --config cloudflare/composio-broker/wrangler.jsonc`
   with that secret.
5. Optional, each with `wrangler secret put` and a fresh random value
   (`openssl rand -base64 32`): `CLOUD_GRANT_SECRET` (shared with the Cloud
   Admin, which mints the grants) and `STATS_TOKEN` (given to Admin for the
   fleet counter). Without them, `PUT /v1/installation/cloud` answers 503 and
   the stats route 404.
