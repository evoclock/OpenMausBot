// The API client against a fake HighLevel: request shapes, trimmed outputs, the Version header, refresh-once-and-retry
// with the rotated pair persisted, 429 backoff, 5xx retry, plain error sentences, and the no-messaging guard.
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { HIGHLEVEL_TOOL_NAMES } from "../../shared/highlevel.ts";
import { removeTempDir } from "../testing/cleanup.ts";
import { FAKE_LOCATION_ID, startFakeHighLevel, startFakeRelay, type FakeHighLevel, type FakeRelay } from "../testing/fake-highlevel.ts";
import { BUDGET_CALLS, FORBIDDEN_PATHS, HIGHLEVEL_CONVERSATIONS_VERSION, HIGHLEVEL_VERSION, HighLevelClient, HighLevelError, assertAllowedPath, isScopeRefusal, lookupLocation, plainError, redactSecrets } from "./client.ts";
import { HIGHLEVEL_NOT_CONNECTED_TEXT, HIGHLEVEL_SIGNED_OUT_TEXT } from "./instructions.ts";
import { createHighLevelRelay } from "./relay.ts";
import { HIGHLEVEL_FILE, HIGHLEVEL_KEY_FILE, HighLevelStore } from "./store.ts";
import { HIGHLEVEL_TOOLS, runHighLevelTool } from "./tools.ts";

let hl: FakeHighLevel;
let relay: FakeRelay;
const dirs: string[] = [];
let clock = 1_800_000_000_000;
const slept: number[] = [];

beforeAll(async () => {
  hl = await startFakeHighLevel();
  relay = await startFakeRelay({ onAccessToken: (token) => hl.tokens.add(token) });
});
afterAll(async () => { await hl.close(); await relay.close(); });
beforeEach(() => { hl.calls.length = 0; hl.overrides.length = 0; hl.pathOverrides.clear(); slept.length = 0; hl.tokens.clear(); relay.refreshes = 0; });
afterEach(async () => { for (const dir of dirs.splice(0)) await removeTempDir(dir); });

function harness(connection: Partial<Parameters<HighLevelStore["put"]>[0]> & { kind?: "oauth" | "token" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omb-highlevel-client-"));
  dirs.push(dir);
  const store = new HighLevelStore({ dataDir: dir, now: () => clock });
  const accessToken = connection.accessToken ?? "hl_access_seed";
  hl.tokens.add(accessToken);
  relay.refreshTokens.add("hl_refresh_seed");
  store.put({ kind: "oauth", accessToken, refreshToken: "hl_refresh_seed", expiresAt: clock + 3_600_000, locationId: FAKE_LOCATION_ID, locationName: "Example Profiles", scopes: "contacts.write", ...connection });
  const upstream = createHighLevelRelay(relay.url);
  const client = new HighLevelClient({ store, refresh: (token) => upstream.refresh(token), apiUrl: hl.url, now: () => clock, sleep: async (ms) => { slept.push(ms); clock += ms; } });
  return { dir, store, client };
}

const last = () => hl.calls.at(-1)!;

describe("HighLevelStore", () => {
  it("rests encrypted under its own 0600 key file and reads back the same connection", () => {
    const { dir } = harness();
    const bytes = readFileSync(join(dir, HIGHLEVEL_FILE));
    expect(bytes.toString("latin1")).not.toContain("hl_access_seed");
    expect(bytes.toString("latin1")).not.toContain("hl_refresh_seed");
    if (process.platform !== "win32") {
      expect(statSync(join(dir, HIGHLEVEL_FILE)).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, HIGHLEVEL_KEY_FILE)).mode & 0o777).toBe(0o600);
    }
    const again = new HighLevelStore({ dataDir: dir });
    expect(again.get()).toMatchObject({ kind: "oauth", accessToken: "hl_access_seed", refreshToken: "hl_refresh_seed", locationId: FAKE_LOCATION_ID, locationName: "Example Profiles", state: "signed-in" });
    expect(again.secretValues()).toEqual(["hl_access_seed", "hl_refresh_seed"]);
    again.rotate({ accessToken: "hl_access_2", refreshToken: "hl_refresh_2", expiresAt: 5 });
    expect(new HighLevelStore({ dataDir: dir }).get()).toMatchObject({ accessToken: "hl_access_2", refreshToken: "hl_refresh_2", expiresAt: 5, state: "signed-in" });
    again.markNeedsSignIn("revoked");
    expect(new HighLevelStore({ dataDir: dir }).get()).toMatchObject({ state: "needs-sign-in", problem: "revoked" });
    again.clear();
    expect(new HighLevelStore({ dataDir: dir }).get()).toBeNull();
  });
});

describe("HighLevelClient requests", () => {
  it("sends the bearer and the Version header on every call, and the conversations version on conversations", async () => {
    const { client } = harness();
    await client.getContact("contact_1");
    expect(last().headers.authorization).toBe("Bearer hl_access_seed");
    expect(last().headers.version).toBe(HIGHLEVEL_VERSION);
    await client.searchConversations({ contactId: "contact_1" });
    expect(last().headers.version).toBe(HIGHLEVEL_CONVERSATIONS_VERSION);
    expect(last().query).toEqual({ locationId: FAKE_LOCATION_ID, contactId: "contact_1", limit: "20" });
    await client.readConversation("conv_1", { limit: 5 });
    expect(last().headers.version).toBe(HIGHLEVEL_CONVERSATIONS_VERSION);
    expect(last().path).toBe("/conversations/conv_1/messages");
  });

  it("trims a contact to what a person cares about and names its custom fields", async () => {
    const { client } = harness();
    const contact = await client.getContact("contact_1");
    expect(contact).toEqual({
      id: "contact_1", name: "Ada Lovelace", firstName: "Ada", lastName: "Lovelace", email: "ada@fixture.test", phone: "+15550001234",
      companyName: "Analytical Engines", tags: ["vip", "newsletter"], source: "web form", assignedTo: "user_1",
      dateAdded: "2026-01-02T03:04:05.000Z", dateUpdated: "2026-02-03T04:05:06.000Z", dnd: false,
      address: { address1: "1 Engine Row", city: "London", country: "GB" }, customFields: { "Lead Source": "Referral", Budget: 1200 },
    });
    expect(JSON.stringify(contact)).not.toMatch(/attributionSource|emailLowerCase|visitorId|dndSettings|10\.0\.0\.1/u);
    // The custom field definitions are fetched once and cached.
    await client.getContact("contact_1");
    expect(hl.calls.filter((call) => call.path.endsWith("/customFields"))).toHaveLength(1);
  });

  it("searches with the location, page and exact filters", async () => {
    const { client } = harness();
    const out = await client.searchContacts({ query: "ada", tag: "vip", email: "ada@fixture.test", limit: 10, page: 2 });
    const search = hl.calls.find((call) => call.path === "/contacts/search")!;
    expect(search.method).toBe("POST");
    expect(search.body).toEqual({ locationId: FAKE_LOCATION_ID, page: 2, pageLimit: 10, query: "ada", filters: [
      { field: "email", operator: "eq", value: "ada@fixture.test" }, { field: "tags", operator: "eq", value: "vip" },
    ] });
    expect(out).toMatchObject({ total: 1, page: 2 });
    expect(out.contacts[0]).toMatchObject({ id: "contact_1", email: "ada@fixture.test" });
  });

  it("creates and updates contacts with the location id and custom fields mapped from names to ids", async () => {
    const { client } = harness();
    await client.createContact({ firstName: "Grace", email: "grace@fixture.test", tags: ["new"], customFields: { "lead source": "Event", "contact.budget": 900 } });
    const create = hl.calls.find((call) => call.path === "/contacts/" && call.method === "POST")!;
    expect(create.body).toEqual({ firstName: "Grace", email: "grace@fixture.test", tags: ["new"], locationId: FAKE_LOCATION_ID,
      customFields: [{ id: "cf_lead", field_value: "Event" }, { id: "cf_budget", field_value: 900 }] });
    await client.updateContact("contact_1", { phone: "+15550002222" });
    expect(last()).toMatchObject({ method: "PUT", path: "/contacts/contact_1", body: { phone: "+15550002222" } });
    await expect(client.updateContact("contact_1", { customFields: { Nope: 1 } })).rejects.toThrow(/no custom field named "Nope"/u);
  });

  it("shapes every other endpoint the tools use", async () => {
    const { client } = harness();
    expect(await client.addTags("contact_1", ["a", "b"])).toEqual({ contactId: "contact_1", tags: ["a", "b"] });
    expect(last()).toMatchObject({ method: "POST", path: "/contacts/contact_1/tags", body: { tags: ["a", "b"] } });
    await client.removeTags("contact_1", ["a"]);
    expect(last()).toMatchObject({ method: "DELETE", path: "/contacts/contact_1/tags", body: { tags: ["a"] } });
    expect((await client.listNotes("contact_1")).notes).toEqual([{ id: "note_1", body: "Called back", dateAdded: "2026-03-03T00:00:00.000Z", userId: "user_1" }]);
    expect((await client.addNote("contact_1", "Left voicemail")).note).toMatchObject({ id: "note_new", body: "Left voicemail" });
    expect(last().body).toEqual({ body: "Left voicemail" });
    expect((await client.listTasks("contact_1")).tasks[0]).toEqual({ id: "task_1", title: "Send quote", dueDate: "2026-03-10T09:00:00.000Z", completed: false, assignedTo: "user_1" });
    await client.addTask("contact_1", { title: "Follow up", dueDate: "2026-03-12T09:00:00.000Z", body: "re: quote" });
    expect(last().body).toEqual({ title: "Follow up", dueDate: "2026-03-12T09:00:00.000Z", body: "re: quote", completed: false });
    expect(await client.listPipelines()).toEqual({ pipelines: [{ id: "pipe_1", name: "Sales", stages: [{ id: "stage_new", name: "New", position: 0 }, { id: "stage_won", name: "Won", position: 1 }] }] });
    expect(last().query).toEqual({ locationId: FAKE_LOCATION_ID });
    const opps = await client.searchOpportunities({ pipelineId: "pipe_1", status: "open", query: "web" });
    expect(last().query).toEqual({ location_id: FAKE_LOCATION_ID, q: "web", pipeline_id: "pipe_1", status: "open", page: "1", limit: "20" });
    expect(opps.opportunities[0]).toEqual({
      id: "opp_1", name: "Website redesign", status: "open", monetaryValue: 4500, pipelineId: "pipe_1", pipelineStageId: "stage_new", contactId: "contact_1",
      contact: { id: "contact_1", name: "Ada Lovelace", email: "ada@fixture.test", phone: "+15550001234", companyName: "Analytical Engines" },
      assignedTo: "user_1", source: "referral", createdAt: "2026-02-28T00:00:00.000Z", updatedAt: "2026-03-02T00:00:00.000Z",
      lastStageChangeAt: "2026-03-02T00:00:00.000Z", lastStatusChangeAt: "2026-03-01T00:00:00.000Z",
    });
    expect(JSON.stringify(opps)).not.toContain("indexVersion");
    await client.getOpportunity("opp_1");
    expect(last()).toMatchObject({ method: "GET", path: "/opportunities/opp_1" });
    await client.createOpportunity({ pipelineId: "pipe_1", contactId: "contact_1", name: "Deal", value: 10, stageId: "stage_new" });
    expect(last().body).toEqual({ pipelineId: "pipe_1", locationId: FAKE_LOCATION_ID, name: "Deal", pipelineStageId: "stage_new", status: "open", contactId: "contact_1", monetaryValue: 10 });
    await client.updateOpportunity("opp_1", { stageId: "stage_won", status: "won" });
    expect(last()).toMatchObject({ method: "PUT", path: "/opportunities/opp_1", body: { pipelineStageId: "stage_won", status: "won" } });
    const conversations = await client.searchConversations({ query: "tuesday" });
    expect(conversations.conversations[0]).toEqual({ id: "conv_1", contactId: "contact_1", contactName: "Ada Lovelace", email: "ada@fixture.test", phone: "+15550001234",
      type: "TYPE_PHONE", lastMessageBody: "See you Tuesday", lastMessageType: "TYPE_SMS", lastMessageDate: new Date(1772000000000).toISOString(), unreadCount: 2 });
    const thread = await client.readConversation("conv_1");
    expect(thread.messages).toEqual([
      { id: "msg_2", type: "TYPE_SMS", direction: "inbound", status: "delivered", dateAdded: "2026-03-05T10:00:00.000Z", body: "See you Tuesday", contentType: "text/plain", attachments: 0 },
      { id: "msg_1", type: "TYPE_SMS", direction: "outbound", status: "delivered", dateAdded: "2026-03-05T09:00:00.000Z", body: "Can we meet?", contentType: "text/plain", attachments: 1 },
    ]);
    expect(thread).toMatchObject({ nextPage: false, lastMessageId: "msg_2" });
    expect((await client.listCalendars()).calendars).toEqual([{ id: "cal_1", name: "Consultations", description: "30 min", isActive: true, calendarType: "round_robin", slotDuration: 30, slotDurationUnit: "mins", teamMembers: 1 }]);
    const events = await client.listEvents({ startTime: "2026-03-10T00:00:00Z", endTime: "2026-03-11T00:00:00Z", calendarId: "cal_1" });
    expect(last().query).toEqual({ locationId: FAKE_LOCATION_ID, calendarId: "cal_1", startTime: String(Date.parse("2026-03-10T00:00:00Z")), endTime: String(Date.parse("2026-03-11T00:00:00Z")) });
    expect(events.events[0]).toEqual({ id: "evt_1", title: "Intro call", calendarId: "cal_1", contactId: "contact_1", appointmentStatus: "confirmed", startTime: "2026-03-10T15:00:00.000Z", endTime: "2026-03-10T15:30:00.000Z", assignedUserId: "user_1", address: "Zoom", notes: "bring deck" });
    await expect(client.listEvents({ startTime: "yesterday", endTime: "2026-03-11T00:00:00Z" })).rejects.toThrow(/startTime must be an ISO 8601/u);
    const location = await client.getLocation();
    expect(location).toMatchObject({ id: FAKE_LOCATION_ID, name: "Example Profiles", timezone: "America/Chicago", city: "Austin" });
    expect(location.customFields).toEqual([
      { id: "cf_lead", name: "Lead Source", key: "contact.lead_source", dataType: "TEXT", model: "contact" },
      { id: "cf_budget", name: "Budget", key: "contact.budget", dataType: "NUMERICAL", model: "contact" },
    ]);
  });
});

describe("HighLevelClient resilience", () => {
  it("refreshes once through the relay on a 401, retries with the new token and keeps the rotated pair", async () => {
    const { client, store, dir } = harness();
    hl.tokens.delete("hl_access_seed");
    const contact = await client.getContact("contact_1");
    expect(contact.id).toBe("contact_1");
    expect(relay.refreshes).toBe(1);
    expect(relay.calls.at(-1)).toEqual({ path: "/v1/highlevel/refresh", body: { refreshToken: "hl_refresh_seed" } });
    const bearers = hl.calls.filter((call) => call.path === "/contacts/contact_1").map((call) => call.headers.authorization);
    expect(bearers).toEqual(["Bearer hl_access_seed", `Bearer ${relay.issued.at(-1)}`]);
    const saved = new HighLevelStore({ dataDir: dir }).get()!;
    expect(saved.accessToken).toBe(relay.issued.at(-1));
    expect(saved.refreshToken).toMatch(/^hl_refresh_\d+$/u);
    expect(saved.refreshToken).not.toBe("hl_refresh_seed");
    expect(saved.expiresAt).toBe(clock + 86_400_000);
    expect(store.get()?.state).toBe("signed-in");
    // Mutation check: a client that forgot to persist the rotation would still hold the spent refresh token.
    hl.tokens.delete(saved.accessToken);
    await client.getContact("contact_1");
    expect(relay.refreshes).toBe(2);
    expect(relay.calls.at(-1)).toEqual({ path: "/v1/highlevel/refresh", body: { refreshToken: saved.refreshToken } });
  });

  it("refreshes ahead of expiry without waiting for a 401", async () => {
    const { client } = harness({ expiresAt: clock + 30_000 });
    await client.listPipelines();
    expect(relay.refreshes).toBe(1);
    expect(hl.calls.filter((call) => call.path === "/opportunities/pipelines")).toHaveLength(1);
    expect(last().headers.authorization).toBe(`Bearer ${relay.issued.at(-1)}`);
  });

  it("marks the store needs-sign-in and answers the signed-out note when the relay rejects the refresh", async () => {
    const { client, store } = harness({ refreshToken: "hl_refresh_revoked" });
    hl.tokens.delete("hl_access_seed");
    await expect(client.getContact("contact_1")).rejects.toMatchObject({ message: HIGHLEVEL_SIGNED_OUT_TEXT, signedOut: true });
    expect(store.get()).toMatchObject({ state: "needs-sign-in", problem: expect.stringMatching(/rejected the saved sign-in/u) });
    // Signed out: no further API or relay calls until a person reconnects.
    const calls = hl.calls.length;
    await expect(client.getContact("contact_1")).rejects.toMatchObject({ signedOut: true });
    expect(hl.calls.length).toBe(calls);
    expect(relay.refreshes).toBe(1);
  });

  it("never refreshes a Private Integration token: a 401 signs it out", async () => {
    const { client, store } = harness({ kind: "token", accessToken: "pit-fixture-token-123", refreshToken: undefined, expiresAt: undefined });
    hl.tokens.delete("pit-fixture-token-123");
    await expect(client.getContact("contact_1")).rejects.toMatchObject({ signedOut: true });
    expect(relay.refreshes).toBe(0);
    expect(store.get()?.state).toBe("needs-sign-in");
  });

  it("waits per the rate-limit headers (capped at 10 s) and retries once on 429", async () => {
    const { client } = harness();
    hl.overrides.push({ status: 429, headers: { "retry-after": "3" }, body: { message: "Too many requests" } });
    await client.getContact("contact_1");
    expect(slept).toEqual([3_000]);
    hl.overrides.push({ status: 429, headers: { "x-ratelimit-interval-milliseconds": "60000" } }, { status: 429 });
    await expect(client.getContact("contact_1")).rejects.toThrow("HighLevel is rate-limiting; try again in a few seconds.");
    expect(slept).toEqual([3_000, 10_000]);
  });

  it("retries a 5xx once and then gives one plain sentence", async () => {
    const { client } = harness();
    hl.overrides.push({ status: 503 });
    expect((await client.getContact("contact_1")).id).toBe("contact_1");
    hl.overrides.push({ status: 502 }, { status: 502 });
    await expect(client.getContact("contact_1")).rejects.toThrow("HighLevel is having trouble (502); try again in a minute.");
  });

  it("keeps under 90 calls per 10 s per location", async () => {
    const { client } = harness();
    for (let i = 0; i < BUDGET_CALLS; i++) await client.listPipelines();
    expect(slept).toEqual([]);
    await client.listPipelines();
    expect(slept).toEqual([10_000]);
  });

  it("turns refusals into plain sentences that name the missing permission or the record", async () => {
    const { client } = harness();
    hl.overrides.push({ status: 403, body: { message: "The token does not have access to this resource." } });
    await expect(client.addNote("contact_1", "x")).rejects.toThrow("HighLevel refused this (403): the connection lacks the contacts.write permission. HighLevel said: The token does not have access to this resource.");
    await expect(client.getContact("missing")).rejects.toThrow("HighLevel has no contact with that id (404).");
    hl.overrides.push({ status: 422, body: { message: ["email must be an email", "phone is invalid"] } });
    await expect(client.createContact({ email: "nope" })).rejects.toThrow("HighLevel rejected this (422): email must be an email; phone is invalid");
    expect(plainError(403, "GET", "/opportunities/search", {}).message).toBe("HighLevel refused this (403): the connection lacks the opportunities.readonly permission.");
    expect(plainError(404, "GET", "/opportunities/x", {}).message).toBe("HighLevel has no opportunity with that id (404).");
  });

  it("answers the not-connected note when nothing is stored", async () => {
    const { client, store } = harness();
    store.clear();
    await expect(client.getContact("contact_1")).rejects.toMatchObject({ message: HIGHLEVEL_NOT_CONNECTED_TEXT, signedOut: true });
  });
});

describe("no messaging through the CRM", () => {
  it("has no method that sends, campaigns, automates or charges, and refuses those paths at the request layer", () => {
    const methods = Object.getOwnPropertyNames(HighLevelClient.prototype).filter((name) => name !== "constructor");
    expect(methods.filter((name) => /send|message|campaign|workflow|payment|invoice|email|sms|whatsapp|delete|remove(?!Tags)/iu.test(name))).toEqual([]);
    for (const [method, path] of [
      ["POST", "/conversations/messages"], ["POST", "/conversations/messages/inbound"], ["PUT", "/conversations/conv_1"], ["DELETE", "/conversations/conv_1"],
      ["POST", "/campaigns/x/contacts"], ["POST", "/contacts/c/campaigns/x"], ["POST", "/contacts/c/workflow/w"], ["POST", "/payments/orders"],
      ["POST", "/calendars/events/appointments"], ["DELETE", "/contacts/c"], ["DELETE", "/opportunities/o"], ["PUT", "/locations/l"], ["POST", "/emails/builder"],
    ] as const) {
      expect(() => assertAllowedPath(method, path), `${method} ${path}`).toThrow(HighLevelError);
    }
    expect(FORBIDDEN_PATHS.some((pattern) => pattern.test("/conversations/messages"))).toBe(true);
    for (const [method, path] of [["GET", "/contacts/c"], ["POST", "/contacts/"], ["DELETE", "/contacts/c/tags"], ["GET", "/conversations/c/messages"], ["GET", "/calendars/events"]] as const) {
      expect(() => assertAllowedPath(method, path)).not.toThrow();
    }
  });

  it("lists exactly the twenty tools and none of them reaches a send endpoint", async () => {
    expect(HIGHLEVEL_TOOLS.map((tool) => tool.name)).toEqual([...HIGHLEVEL_TOOL_NAMES]);
    expect(HIGHLEVEL_TOOLS.map((tool) => tool.name).filter((name) => /SEND|MESSAGE|CAMPAIGN|WORKFLOW|PAY|DELETE/u.test(name))).toEqual([]);
    const { client } = harness();
    const sample: Record<string, Record<string, unknown>> = {
      HIGHLEVEL_SEARCH_CONTACTS: { query: "ada" }, HIGHLEVEL_GET_CONTACT: { contactId: "contact_1" }, HIGHLEVEL_CREATE_CONTACT: { email: "x@y.test" },
      HIGHLEVEL_UPDATE_CONTACT: { contactId: "contact_1", city: "Austin" }, HIGHLEVEL_ADD_TAGS: { contactId: "contact_1", tags: ["a"] }, HIGHLEVEL_REMOVE_TAGS: { contactId: "contact_1", tags: ["a"] },
      HIGHLEVEL_LIST_NOTES: { contactId: "contact_1" }, HIGHLEVEL_ADD_NOTE: { contactId: "contact_1", body: "n" }, HIGHLEVEL_LIST_TASKS: { contactId: "contact_1" },
      HIGHLEVEL_ADD_TASK: { contactId: "contact_1", title: "t", dueDate: "2026-03-12T09:00:00Z" }, HIGHLEVEL_LIST_PIPELINES: {}, HIGHLEVEL_SEARCH_OPPORTUNITIES: {},
      HIGHLEVEL_GET_OPPORTUNITY: { opportunityId: "opp_1" }, HIGHLEVEL_CREATE_OPPORTUNITY: { pipelineId: "pipe_1", contactId: "contact_1", name: "d" },
      HIGHLEVEL_UPDATE_OPPORTUNITY: { opportunityId: "opp_1", status: "won" }, HIGHLEVEL_SEARCH_CONVERSATIONS: {}, HIGHLEVEL_READ_CONVERSATION: { conversationId: "conv_1" },
      HIGHLEVEL_LIST_CALENDARS: {}, HIGHLEVEL_LIST_EVENTS: { startTime: "2026-03-10T00:00:00Z", endTime: "2026-03-11T00:00:00Z" }, HIGHLEVEL_GET_LOCATION: {},
    };
    for (const name of HIGHLEVEL_TOOL_NAMES) {
      const { result } = await runHighLevelTool(client, name, sample[name]!);
      expect(result.isError, name).toBeUndefined();
    }
    for (const call of hl.calls) {
      expect(call.path, `${call.method} ${call.path}`).not.toMatch(/campaigns|workflow|payments/u);
      if (call.path.includes("messages")) expect(call.method, call.path).toBe("GET");
      if (call.path.startsWith("/conversations")) expect(call.method).toBe("GET");
    }
    expect(hl.calls.some((call) => call.method === "POST" && call.path.startsWith("/conversations"))).toBe(false);
  });
});

// HighLevel's real answers: a dead token, a live token missing a scope, a token from another location.
const INVALID_TOKEN = { statusCode: 401, message: "Invalid JWT" };
const MISSING_SCOPE = { statusCode: 401, message: "The token is not authorized for this scope.", error: "Unauthorized" };
const OTHER_LOCATION = { statusCode: 403, message: "The token does not have access to this location." };
const CUSTOM_FIELDS = `GET /locations/${FAKE_LOCATION_ID}/customFields`;

describe("a missing permission is not a sign-out", () => {
  it("tells a scope refusal from a dead token by HighLevel's own words", () => {
    expect(isScopeRefusal(MISSING_SCOPE)).toBe(true);
    expect(isScopeRefusal({ message: "insufficient_scope" })).toBe(true);
    expect(isScopeRefusal(INVALID_TOKEN)).toBe(false);
    expect(isScopeRefusal({ statusCode: 401, message: "Invalid token: access token is invalid", error: "Unauthorized" })).toBe(false);
    expect(isScopeRefusal({})).toBe(false);
    expect(plainError(401, "GET", `/locations/${FAKE_LOCATION_ID}/customFields`, MISSING_SCOPE)).toMatchObject({
      message: "HighLevel refused this (401): the connection lacks the View Custom Fields permission (locations/customFields.readonly). HighLevel said: The token is not authorized for this scope.",
      signedOut: false, status: 401,
    });
    expect(plainError(401, "GET", "/contacts/c", INVALID_TOKEN)).toMatchObject({ message: HIGHLEVEL_SIGNED_OUT_TEXT, signedOut: true });
  });

  it("keeps a token connection signed in when only the custom-fields lookup inside a contact read is refused", async () => {
    const { client, store } = harness({ kind: "token", accessToken: "pit-fixture-token-123", refreshToken: undefined, expiresAt: undefined });
    hl.pathOverrides.set(CUSTOM_FIELDS, { status: 401, body: MISSING_SCOPE });
    const contact = await client.getContact("contact_1");
    expect(contact).toMatchObject({ id: "contact_1", email: "ada@fixture.test", customFields: { cf_lead: "Referral", cf_budget: 1200 } });
    expect(store.get()).toMatchObject({ state: "signed-in" });
    expect(store.get()?.problem).toBeUndefined();
    // The refusal is remembered for the cache's lifetime: later reads do not ask again.
    await client.getContact("contact_1");
    expect((await client.searchContacts({ query: "ada" })).contacts[0]).toMatchObject({ id: "contact_1" });
    expect(hl.calls.filter((call) => call.path.endsWith("/customFields"))).toHaveLength(1);
    expect((await client.getLocation()).customFields).toEqual([]);
    // A write that names a custom field says which permission is missing, not that the field does not exist.
    await expect(client.updateContact("contact_1", { customFields: { "Lead Source": "Event" } })).rejects.toMatchObject({
      message: expect.stringMatching(/^HighLevel refused this \(401\): the connection lacks the View Custom Fields permission/u), signedOut: false,
    });
    expect(store.get()?.state).toBe("signed-in");
    // Through the tool layer: the bot gets a plain error, not the signed-out note.
    const { result } = await runHighLevelTool(client, "HIGHLEVEL_GET_CONTACT", { contactId: "contact_1" });
    expect(result.isError).toBeUndefined();
  });

  it("keeps an OAuth connection signed in on a scope refusal, without spending a refresh", async () => {
    const { client, store } = harness();
    hl.pathOverrides.set(CUSTOM_FIELDS, { status: 401, body: MISSING_SCOPE });
    expect((await client.getContact("contact_1")).id).toBe("contact_1");
    expect(relay.refreshes).toBe(0);
    expect(store.get()?.state).toBe("signed-in");
  });

  it("answers a scope refusal on the call itself with the missing permission, still signed in", async () => {
    const { client, store } = harness({ kind: "token", accessToken: "pit-fixture-token-123", refreshToken: undefined, expiresAt: undefined });
    hl.pathOverrides.set("POST /contacts/contact_1/notes", { status: 401, body: MISSING_SCOPE });
    const { result } = await runHighLevelTool(client, "HIGHLEVEL_ADD_NOTE", { contactId: "contact_1", body: "x" });
    expect(result).toMatchObject({ isError: true, structuredContent: {
      error: "HighLevel refused this (401): the connection lacks the Edit Contacts permission (contacts.write). HighLevel said: The token is not authorized for this scope.",
      status: 401,
    } });
    expect(result.structuredContent?.signedOut).toBeUndefined();
    expect(store.get()?.state).toBe("signed-in");
  });

  it("still signs a token out when HighLevel rejects the token itself, on the main call or the custom-fields lookup", async () => {
    const dead = harness({ kind: "token", accessToken: "pit-fixture-dead-123", refreshToken: undefined, expiresAt: undefined });
    hl.tokens.delete("pit-fixture-dead-123");
    await expect(dead.client.getContact("contact_1")).rejects.toMatchObject({ message: HIGHLEVEL_SIGNED_OUT_TEXT, signedOut: true });
    expect(dead.store.get()).toMatchObject({ state: "needs-sign-in", problem: "HighLevel rejected the Private Integration token." });

    // Revoked between the two calls: the optional lookup's 401 is not a scope refusal, so it signs out.
    const revoked = harness({ kind: "token", accessToken: "pit-fixture-revoked-1", refreshToken: undefined, expiresAt: undefined });
    hl.pathOverrides.set(CUSTOM_FIELDS, { status: 401, body: INVALID_TOKEN });
    await revoked.client.getContact("contact_1");
    expect(revoked.store.get()?.state).toBe("needs-sign-in");
    await expect(revoked.client.getContact("contact_1")).rejects.toMatchObject({ signedOut: true });
  });

  it("still refreshes an OAuth token on a dead-token 401", async () => {
    const { client, store } = harness();
    hl.overrides.push({ status: 401, body: INVALID_TOKEN });
    expect((await client.getContact("contact_1")).id).toBe("contact_1");
    expect(relay.refreshes).toBe(1);
    expect(store.get()?.state).toBe("signed-in");
  });
});

describe("lookupLocation", () => {
  it("validates a Private Integration token against its location and returns the name", async () => {
    hl.tokens.add("pit-valid-token-123");
    expect(await lookupLocation({ token: "pit-valid-token-123", locationId: FAKE_LOCATION_ID, apiUrl: hl.url })).toEqual({ id: FAKE_LOCATION_ID, name: "Example Profiles", companyId: "company_1", timezone: "America/Chicago" });
    expect(last().headers.version).toBe(HIGHLEVEL_VERSION);
    await expect(lookupLocation({ token: "pit-valid-token-123", locationId: "other_location", apiUrl: hl.url })).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/^This token does not belong to that location \(403\)/u) });
    await expect(lookupLocation({ token: "pit-bad", locationId: FAKE_LOCATION_ID, apiUrl: hl.url })).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/^HighLevel did not accept this token \(401\)/u) });
    hl.pathOverrides.set(`GET /locations/${FAKE_LOCATION_ID}`, { status: 401, body: MISSING_SCOPE });
    await expect(lookupLocation({ token: "pit-valid-token-123", locationId: FAKE_LOCATION_ID, apiUrl: hl.url })).rejects.toMatchObject({ status: 401, message: expect.stringMatching(/^This token is missing the View Locations permission/u) });
  });

  const TOKEN = "pit-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
  const answering = (status: number, body?: unknown): typeof fetch => async () => new Response(body === undefined ? "" : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const check = async (status: number, body?: unknown) => {
    const error = await lookupLocation({ token: TOKEN, locationId: FAKE_LOCATION_ID, apiUrl: "https://hl.fixture.test", fetch: answering(status, body) }).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(HighLevelError);
    expect((error as HighLevelError).signedOut).toBe(false);
    expect((error as HighLevelError).message).not.toContain(TOKEN);
    return error as HighLevelError;
  };

  it("says which case a refusal is, in plain words, with HighLevel's own reason when it gave one", async () => {
    expect(await check(401, MISSING_SCOPE)).toMatchObject({ status: 401, message:
      "This token is missing the View Locations permission (401), which OpenMausBot needs to check it. In HighLevel, open Settings → Private Integrations, " +
      "edit this integration, turn on View Locations and save, then connect again: the token stays the same. HighLevel said: The token is not authorized for this scope." });
    expect(await check(401, INVALID_TOKEN)).toMatchObject({ status: 401, message:
      "HighLevel did not accept this token (401). Check that it was copied whole and has not been rotated or deleted, " +
      "and that its Private Integration has the View Locations permission. HighLevel said: Invalid JWT" });
    expect((await check(401)).message).toBe(
      "HighLevel did not accept this token (401). Check that it was copied whole and has not been rotated or deleted, " +
      "and that its Private Integration has the View Locations permission.");
    expect(await check(403, OTHER_LOCATION)).toMatchObject({ status: 403, message:
      "This token does not belong to that location (403): it was created in another sub-account or at the agency level. " +
      "Create the Private Integration inside the sub-account whose location ID you entered. HighLevel said: The token does not have access to this location." });
    expect((await check(403, {})).message).toBe(
      "This token does not belong to that location (403): it was created in another sub-account or at the agency level. " +
      "Create the Private Integration inside the sub-account whose location ID you entered.");
    expect(await check(404, { statusCode: 404, message: "Location not found" })).toMatchObject({ status: 404, message:
      "HighLevel has no location with that ID (404). Copy the location ID from Settings → Business Profile in the sub-account where you created the token." });
    expect((await check(422, { statusCode: 422, message: ["locationId must be a string"] })).message).toBe("HighLevel rejected this (422): locationId must be a string");
  });

  it("never repeats the token, or anything shaped like one, and keeps HighLevel's reason to one short line", async () => {
    const echoed = await check(401, { message: `Invalid JWT ${TOKEN} (Bearer ${TOKEN}); also pit-abcdefgh1234 and eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2ln` });
    expect(echoed.message).toMatch(/HighLevel said: Invalid JWT \[redacted\] \(Bearer \[redacted\]\); also \[redacted\] and \[redacted\]$/u);
    expect(echoed.message).not.toMatch(/pit-|eyJ|0f1e2d3c/u);
    const long = await check(403, { message: `line one\nline\ttwo ${"x".repeat(400)}` });
    const said = long.message.split("HighLevel said: ")[1]!;
    expect(said.startsWith("line one line two x")).toBe(true);
    expect(said).toHaveLength(160);
    expect(said.endsWith("…")).toBe(true);
    // The exact secret goes even when it has no token shape (an OAuth access token need not look like one).
    expect(redactSecrets("token opaque-secret-42 was refused", ["opaque-secret-42"])).toBe("token [redacted] was refused");
    expect(redactSecrets("Bearer token is missing")).toBe("Bearer token is missing");
    // A token split across the cut is redacted before cutting, so no fragment survives.
    const cut = await check(401, { message: `${"y".repeat(150)} ${TOKEN}` });
    expect(cut.message).not.toMatch(/pit-|0f1e/u);
  });
});
