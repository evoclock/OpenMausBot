/**
 * Saved logins: a website username and password (and optionally its 2FA key)
 * a bot signs in with but never receives: it calls fill_login and the server
 * fills the fields itself. Clients see a saved login as a list row, never its
 * secrets.
 */
import { getDomain } from "tldts";

/** Where a login came from: the sign-in card's Save, Settings, or the person's
 * 1Password vault (read-only here). */
export type LoginSource = "card" | "settings" | "1password";

/** Which bots may use a login: every bot, or the ones named. */
export type LoginBots = "all" | string[];

/** Where a login may be filled. */
export interface LoginPlace {
  /** Its site: the registrable domain, such as example.com. A name under a
   * suffix that hands out names to anyone (github.io, vercel.app) is a site
   * of its own, so alice.github.io and bob.github.io never share a login. */
  site: string;
  /** Hosts its sign-in page was seen on, such as accounts.example.com or
   * login.microsoftonline.com. A login fills on these even off its site. */
  hosts: string[];
  /** Filled only on `hosts`, never elsewhere on its site. */
  exactHost: boolean;
}

/** One saved login as Settings shows it. There is no password field, and no
 * route ever returns one: a saved password is only ever replaced. */
export interface LoginSummary extends LoginPlace {
  id: string;
  username: string;
  /** A 2FA setup key is saved, so the one-time code is filled too. */
  hasTotp: boolean;
  source: LoginSource;
  bots: LoginBots;
  createdAt: number;
  lastUsedAt?: number;
}

/** A 1Password vault the service account reads, and the bots that may use its
 * logins. A vault nobody narrowed is for every bot. */
export interface OnePasswordVault {
  id: string;
  title: string;
  /** Its Login items with a website and a password. */
  items: number;
  bots: LoginBots;
}

/** 1Password, connected with a service account. The token itself never leaves
 * the server. */
export interface OnePasswordStatus {
  connected: boolean;
  vaults?: OnePasswordVault[];
  /** How many items have a website and a password, across every vault. */
  items?: number;
  error?: string;
}

/** The longest username or password a form takes. */
export const LOGIN_FIELD_MAX = 512;

/** The most sign-in hosts one login keeps. */
export const LOGIN_HOSTS_MAX = 20;

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

/** A host as pages report it: lower case, without the root's trailing dot. */
export function plainHost(host: string): string {
  return host.toLowerCase().replace(/\.$/u, "");
}

/** The site a host belongs to. Loopback names, IP addresses and hosts that
 * are themselves a public suffix are their own site. */
export function loginSite(host: string): string {
  const name = plainHost(host);
  return getDomain(name, { allowPrivateDomains: true }) ?? name;
}

/** A login's host from what the person typed: a page address or a bare
 * domain. Anything that is not a plain http(s) address is refused. */
export function normalizeLoginHost(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  // eslint-disable-next-line no-control-regex -- Reject control characters and spaces before URL parsing normalizes them.
  if (!text || text.length > 2048 || /[\u0000- \u007f\\]/u.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname || url.username || url.password) return null;
  const host = plainHost(url.hostname);
  if (!host.includes(".") && host !== "localhost" && !host.startsWith("[")) return null;
  return host;
}

/** Where a new login may be filled: the site of the address it was saved
 * for, and the hosts its sign-in page was seen on (that address's own host
 * when none was). */
export function loginPlace(host: string, signInHosts: readonly string[] = [], exactHost = false): LoginPlace {
  const hosts = [...new Set(signInHosts.length ? signInHosts : [host])].slice(0, LOGIN_HOSTS_MAX);
  return { site: loginSite(host), hosts, exactHost };
}

/** Whether a login may be filled on a page whose host is `pageHost`: one of
 * its sign-in hosts, or (unless it is kept to those) any host of its site. */
export function loginMatchesHost(login: LoginPlace, pageHost: string): boolean {
  const host = plainHost(pageHost);
  return login.hosts.includes(host) || (!login.exactHost && loginSite(host) === login.site);
}

/** Whether `pageUrl` is a page any login may be filled on: https, or plain
 * http on this computer, for a developer's own app. A reason when not. */
export function loginPageCheck(pageUrl: string): { ok: true; pageHost: string } | { ok: false; pageHost: string | null; reason: "address" | "insecure" } {
  let url: URL;
  try { url = new URL(pageUrl); } catch { return { ok: false, pageHost: null, reason: "address" }; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, pageHost: null, reason: "address" };
  const pageHost = plainHost(url.hostname);
  if (url.protocol === "http:" && !isLoopbackHost(pageHost)) return { ok: false, pageHost, reason: "insecure" };
  return { ok: true, pageHost };
}

/** Whether `login` may be filled on the page at `pageUrl`: a page any login
 * may be filled on, at a host the login matches. */
export function loginOriginCheck(pageUrl: string, login: LoginPlace): { ok: true; pageHost: string } | { ok: false; pageHost: string | null; reason: "address" | "insecure" | "host" } {
  const page = loginPageCheck(pageUrl);
  if (!page.ok) return page;
  return loginMatchesHost(login, page.pageHost) ? page : { ok: false, pageHost: page.pageHost, reason: "host" };
}

/** Whether a bot may use a login. */
export function loginUsableBy(login: { bots: LoginBots }, botId: string): boolean {
  return login.bots === "all" || login.bots.includes(botId);
}

/** A login as a bot hears of it: its site, or its hosts when it is kept to
 * them, and the username. */
export function loginLabel(login: LoginPlace & { username: string }): string {
  const where = login.exactHost ? login.hosts.join(" or ") : login.site;
  return login.username ? `${where} (${login.username})` : where;
}

/** The resume line after the person saved a login from a sign-in card. */
export function savedLoginResumePrompt(site: string): string {
  return `OpenMausBot sign-in update: the person saved a login for ${site}. Open its login page in your browser and call fill_login there: it fills the form and submits it. Then check you are signed in. You never see the password. Never ask for a password or a one-time code in chat.`;
}
