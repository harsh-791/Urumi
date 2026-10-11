import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

export class SsrfError extends Error {}

export type ResolvedAddress = { address: string; family: number };
export type DnsLookup = (hostname: string) => Promise<ResolvedAddress[]>;

const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.google.com",
  "metadata.internal",
  "instance-data",
  "169.254.169.254",
]);

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const linkLocal = new BlockList();
linkLocal.addSubnet("169.254.0.0", 16, "ipv4");
linkLocal.addSubnet("fe80::", 10, "ipv6");

const privateNets = new BlockList();
privateNets.addSubnet("10.0.0.0", 8, "ipv4");
privateNets.addSubnet("172.16.0.0", 12, "ipv4");
privateNets.addSubnet("192.168.0.0", 16, "ipv4");
privateNets.addSubnet("fc00::", 7, "ipv6");

const unspecified = new BlockList();
unspecified.addSubnet("0.0.0.0", 8, "ipv4");
unspecified.addAddress("::", "ipv6");

const multicast = new BlockList();
multicast.addSubnet("224.0.0.0", 4, "ipv4");
multicast.addSubnet("ff00::", 8, "ipv6");

export const defaultLookup: DnsLookup = async (hostname) => {
  const rows = await dnsLookup(hostname, { all: true, verbatim: true });
  return rows.map((row) => ({ address: row.address, family: row.family }));
};

function classify(ip: string): "public" | "private" | "loopback" | "linklocal" | "bad" {
  const family = isIP(ip) === 6 ? "ipv6" : isIP(ip) === 4 ? "ipv4" : null;
  if (!family) return "bad";
  if (loopback.check(ip, family) || unspecified.check(ip, family) || multicast.check(ip, family)) {
    return loopback.check(ip, family) ? "loopback" : "bad";
  }
  if (linkLocal.check(ip, family)) return "linklocal";
  if (privateNets.check(ip, family)) return "private";
  return "public";
}

export function isClusterDns(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host.endsWith(".svc.cluster.local") || host.endsWith(".svc");
}

export async function assertUrlAllowed(
  raw: string,
  options: { allowClusterUrls: boolean; lookup?: DnsLookup },
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("URL is not valid");
  }
  if (url.username || url.password) throw new SsrfError("URL must not include credentials");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfError("Only http and https URLs are allowed");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new SsrfError("URL is missing a host");
  if (METADATA_HOSTS.has(hostname) || /^\d+$/.test(hostname)) {
    throw new SsrfError("That host is blocked");
  }

  const cluster = isClusterDns(hostname);
  if (url.protocol === "http:" && !cluster) {
    throw new SsrfError("Public MCP servers must use https");
  }
  if (cluster && !options.allowClusterUrls) {
    throw new SsrfError("Cluster-internal URLs are disabled");
  }

  const literal = isIP(hostname) !== 0;
  const addresses = literal
    ? [{ address: hostname, family: isIP(hostname) }]
    : await (options.lookup ?? defaultLookup)(hostname);

  if (addresses.length === 0) throw new SsrfError("Host did not resolve");

  for (const address of addresses) {
    const kind = classify(address.address);
    if (kind === "linklocal" || kind === "loopback" || kind === "bad") {
      throw new SsrfError("That address is blocked");
    }
    if (kind === "private") {
      if (!(options.allowClusterUrls && cluster)) {
        throw new SsrfError("Private addresses are only allowed for Kubernetes service DNS");
      }
    }
  }
  return url;
}
