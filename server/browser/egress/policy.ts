// What a bot's browser may connect to: every address a destination resolves to gets a class, and the host
// OpenMausBot runs on decides which classes pass.
//
// The address ranges, the NAT64 and 6to4 unwrapping and this machine's own addresses are adapted from
// pingdotgg/t3code@00cdceb1 apps/server/src/htmlRender/publicProxy.ts, MIT License, Copyright (c) 2026
// T3 Tools Inc. (full text in third_party/t3-code/LICENSE); modified: an address gets a class instead of
// local-or-public, cloud metadata addresses are a class of their own, and the answer depends on the host.
import { BlockList, isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { z } from "zod";

/** `desktop`: the app on someone's computer. `server`: self-hosted (Docker, npm). `cloud`: a MausBot Cloud home. */
export type EgressHost = "desktop" | "server" | "cloud";

export type AddressClass = "public" | "loopback" | "this-machine" | "private" | "link-local" | "metadata" | "reserved";

export type Refusal = "omb" | "this-computer" | "local-network" | "link-local" | "metadata" | "reserved" | "rebinding" | "reddit";

/** How a refusal reads in the page-health line. */
export const REFUSAL_TEXT: Record<Refusal, string> = {
  omb: "OpenMausBot's own service",
  "this-computer": "a service on this computer that no bot started",
  "local-network": "the local network",
  "link-local": "a link-local address",
  metadata: "the cloud metadata service",
  reserved: "a reserved address",
  rebinding: "a web address that points at this computer",
  reddit: "Reddit",
};

const family = (address: string) => (isIP(address) === 6 ? "ipv6" : "ipv4");

function subnets(entries: ReadonlyArray<readonly [string, number]>): BlockList {
  const list = new BlockList();
  for (const [network, prefix] of entries) list.addSubnet(network, prefix, family(network));
  return list;
}

const LOOPBACK = subnets([["127.0.0.0", 8], ["::1", 128]]);
// ::/96 (IPv4-compatible, which also holds the unspecified address), local-use NAT64 and Teredo carry an
// IPv4 address a translator may route to without checking it.
const RESERVED = subnets([
  ["0.0.0.0", 8], ["198.18.0.0", 15], ["224.0.0.0", 3],
  ["::", 96], ["64:ff9b:1::", 48], ["2001::", 32], ["ff00::", 8],
]);
const LINK_LOCAL = subnets([["169.254.0.0", 16], ["fe80::", 10]]);
// fc00::/7 holds Fly's private 6PN network (fdaa::/16), which links a Cloud home to other customers' machines.
const PRIVATE = subnets([["10.0.0.0", 8], ["100.64.0.0", 10], ["172.16.0.0", 12], ["192.168.0.0", 16], ["fc00::", 7]]);
// AWS (IPv4 and IPv6), Azure, GCP and Oracle answer on 169.254.169.254; Alibaba on 100.100.100.200.
const METADATA = new BlockList();
for (const address of ["169.254.169.254", "fd00:ec2::254", "100.100.100.200"]) METADATA.addAddress(address, family(address));

const NAT64 = subnets([["64:ff9b::", 96]]);
const SIX_TO_FOUR = subnets([["2002::", 16]]);

/** The sixteen-bit groups of an IPv6 address, which may end in dotted IPv4. */
function ipv6Groups(address: string): number[] {
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(address);
  const text = dotted
    ? `${address.slice(0, dotted.index)}${((+dotted[1]! << 8) | +dotted[2]!).toString(16)}:${((+dotted[3]! << 8) | +dotted[4]!).toString(16)}`
    : address;
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(fill).fill("0"), ...right].map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address a NAT64 or 6to4 address stands for, which a translator will route to. */
function embeddedIPv4(address: string): string | undefined {
  const at = NAT64.check(address, "ipv6") ? 6 : SIX_TO_FOUR.check(address, "ipv6") ? 1 : -1;
  if (at === -1) return undefined;
  const groups = ipv6Groups(address);
  const high = groups[at] ?? 0;
  const low = groups[at + 1] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** The addresses this machine's interfaces hold right now; IPv4-mapped IPv6 matches their IPv4 entries. */
export function ownAddresses(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): BlockList {
  const own = new BlockList();
  for (const entry of Object.values(interfaces).flat()) {
    if (entry) own.addAddress(entry.address.split("%", 1)[0]!, entry.family === "IPv6" ? "ipv6" : "ipv4");
  }
  return own;
}

export function addressClass(raw: string, own: BlockList = ownAddresses()): AddressClass {
  const address = raw.split("%", 1)[0]!;
  if (!isIP(address)) return "reserved";
  const type = family(address);
  const embedded = type === "ipv6" ? embeddedIPv4(address) : undefined;
  if (embedded !== undefined) return addressClass(embedded, own);
  if (METADATA.check(address, type)) return "metadata";
  if (LOOPBACK.check(address, type)) return "loopback";
  if (RESERVED.check(address, type)) return "reserved";
  if (LINK_LOCAL.check(address, type)) return "link-local";
  if (own.check(address, type)) return "this-machine";
  if (PRIVATE.check(address, type)) return "private";
  return "public";
}

/** An address literal, or a name RFC 6761 and Chrome resolve to loopback themselves. */
export function namesThisMachine(host: string): boolean {
  return isIP(host) !== 0 || /^(?:[^.]+\.)*localhost\.?$/i.test(host);
}

/** `browserEngine.egress` in config.json. */
export const browserEgressConfigSchema = z.object({
  /** Self-hosted servers only: local-network or this-computer destinations bots' browsers may reach, as
   * `10.0.0.5`, `192.168.1.0/24`, `10.0.0.5:8080`, `fd12::/48` or `[fd12::1]:443`. OpenMausBot's own ports,
   * cloud metadata and link-local addresses stay closed. MausBot Cloud ignores it. */
  allow: z.array(z.string().trim().max(64).refine((entry) => parseAllowEntry(entry) !== null, {
    message: "must be an IP address or CIDR range, with an optional :port",
  })).max(64).optional(),
  /** Desktop only: false keeps bots' browsers off the local network (the default lets them reach it). */
  localNetwork: z.boolean().optional(),
});
export type BrowserEgressConfig = z.output<typeof browserEgressConfigSchema>;

interface AllowEntry { network: string; prefix: number; port: number | null }

export function parseAllowEntry(entry: string): AllowEntry | null {
  // A bare IPv6 address has colons of its own, so only its bracketed form takes a port.
  const match = /^\[([^\]]+)\](?:\/(\d{1,3}))?(?::(\d{1,5}))?$/.exec(entry)
    ?? (entry.split(":").length > 2 ? /^([^/]+)(?:\/(\d{1,3}))?()$/.exec(entry) : /^([^/:]+)(?:\/(\d{1,3}))?(?::(\d{1,5}))?$/.exec(entry));
  if (!match) return null;
  const [, network = "", prefixText, portText] = match;
  const kind = isIP(network);
  if (!kind) return null;
  const max = kind === 6 ? 128 : 32;
  const prefix = prefixText === undefined ? max : Number(prefixText);
  const port = portText ? Number(portText) : null;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65_535)) return null;
  return { network, prefix, port };
}

export function allowList(entries: readonly string[] | undefined): (address: string, port: number) => boolean {
  const rules = (entries ?? []).flatMap((entry) => {
    const parsed = parseAllowEntry(entry);
    if (!parsed) return [];
    const list = new BlockList();
    list.addSubnet(parsed.network, parsed.prefix, family(parsed.network));
    return [{ list, port: parsed.port }];
  });
  return (raw, port) => {
    const address = raw.split("%", 1)[0]!;
    return rules.some((rule) => (rule.port === null || rule.port === port) && rule.list.check(address, family(address)));
  };
}

export interface EgressRules {
  host: EgressHost;
  /** A port one of OpenMausBot's own listeners holds on this machine. */
  ownPort(port: number): boolean;
  /** Whether every listener on this loopback port belongs to a bot's processes. */
  botPort(port: number): Promise<boolean>;
  /** Desktop: the person's local network. */
  localNetwork: boolean;
  /** Self-hosted servers: `browserEngine.egress.allow`. */
  allowed(address: string, port: number): boolean;
}

/**
 * Why a connection to `host:port`, resolved to `addresses`, is refused, or null when it may go ahead.
 * Every address must pass: the gate connects only to addresses checked here.
 */
export async function refusalFor(
  target: { host: string; port: number },
  addresses: readonly { address: string }[],
  rules: EgressRules,
  own: BlockList = ownAddresses(),
): Promise<Refusal | null> {
  const { host, port } = target;
  for (const { address } of addresses) {
    const kind = addressClass(address, own);
    if (kind === "public") continue;
    if (kind === "metadata" || kind === "link-local" || kind === "reserved") return kind;
    if (kind === "private") {
      const open = rules.host === "desktop" ? rules.localNetwork : rules.host === "server" && rules.allowed(address, port);
      if (open) continue;
      return "local-network";
    }
    if (rules.ownPort(port)) return "omb";
    // Desktop dev servers are reached by name or address, never through a public name that points here.
    if (rules.host === "desktop") {
      if (namesThisMachine(host)) continue;
      return "rebinding";
    }
    if (rules.host === "server" && rules.allowed(address, port)) continue;
    if (await rules.botPort(port)) continue;
    return "this-computer";
  }
  return null;
}
