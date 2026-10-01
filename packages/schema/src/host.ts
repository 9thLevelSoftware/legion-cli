/**
 * The one SSRF host classifier. `persist` (ingest/fetch) and `http` (adapter) both re-export it;
 * do not fork it. Pure string logic, no network.
 */
const PRIVATE_HOSTS = new Set(["localhost", "metadata.google.internal"]);

function ipv4Octets(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((part) => Number(part));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return nums;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b, c] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // RFC 6598 shared address space (CGNAT), including Alibaba 100.100.100.200 IMDS
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;
  // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 0 && c === 0) return true;
  // Documentation networks and the deprecated 6to4 relay prefix are not public endpoints.
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  // 198.18.0.0/15 benchmarking
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 multicast, 240.0.0.0/4 reserved (includes 255.255.255.255 broadcast)
  if (a !== undefined && a >= 224) return true;
  return false;
}

function hextetsToIpv4(hi: number, lo: number): number[] {
  return [(hi >> 8) & 255, hi & 255, (lo >> 8) & 255, lo & 255];
}

function normalizeHost(hostname: string): string {
  // Drop an IPv6 zone id (`fe80::1%eth0`): it names an interface, not a different address.
  return hostname.replace(/^\[|\]$/g, "").replace(/%.*$/, "").toLowerCase();
}

/** Expand an IPv6 literal to eight 16-bit words, or null when it is not one. */
function ipv6Words(host: string): number[] | null {
  let h = normalizeHost(host);
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted?.[1]) {
    const v4 = ipv4Octets(dotted[1]);
    if (!v4) return null;
    const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
    h = `${h.slice(0, -dotted[1].length)}${hex(v4[0]!, v4[1]!)}:${hex(v4[2]!, v4[3]!)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === "") return [];
    const words = part.split(":").map((w) => (/^[0-9a-f]{1,4}$/.test(w) ? Number.parseInt(w, 16) : Number.NaN));
    return words.some(Number.isNaN) ? null : words;
  };
  const head = parse(halves[0] ?? "");
  const tail = halves.length === 2 ? parse(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) embed an IPv4 address. Anchored on the
 * leading words: `fe80::ffff:808:808` is link-local, not a mapped 8.8.8.8.
 */
function embeddedIpv4(host: string): number[] | null {
  const words = ipv6Words(host);
  if (!words || !words.slice(0, 5).every((w) => w === 0)) return null;
  if (words[5] !== 0xffff && words[5] !== 0) return null;
  return hextetsToIpv4(words[6]!, words[7]!);
}

function isPrivateIPv6(host: string): boolean {
  const words = ipv6Words(host);
  if (!words) return false;
  const [w0, w1] = words as [number, number];
  // ::ffff:0:0/96 SIIT (IPv4-translated): the IPv4 address is in the last two words
  if (words.slice(0, 4).every((w) => w === 0) && words[4] === 0xffff && words[5] === 0) {
    return isPrivateIPv4(hextetsToIpv4(words[6]!, words[7]!));
  }
  // ::1 loopback and :: unspecified
  if (words.slice(0, 7).every((w) => w === 0) && (words[7] === 0 || words[7] === 1)) return true;
  // fe80::/10 link-local
  if ((w0 & 0xffc0) === 0xfe80) return true;
  // fec0::/10 deprecated site-local and 2001:db8::/32 documentation.
  if ((w0 & 0xffc0) === 0xfec0) return true;
  if (w0 === 0x2001 && w1 === 0x0db8) return true;
  // fc00::/7 unique local
  if ((w0 & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((w0 & 0xff00) === 0xff00) return true;
  // 64:ff9b::/96 NAT64: a translator can reach the IPv4 side, so treat it as internal
  if (w0 === 0x64 && w1 === 0xff9b && words.slice(2, 6).every((w) => w === 0)) return true;
  // 2002::/16 6to4 embeds an IPv4 address and is a relay path
  if (w0 === 0x2002) return true;
  return false;
}

export function isPrivateOrLocalHost(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (PRIVATE_HOSTS.has(host)) return true;
  if (host.endsWith(".localhost") || host.endsWith(".local")) return true;
  const mapped = embeddedIpv4(host);
  if (mapped) return isPrivateIPv4(mapped);
  const ipv4 = ipv4Octets(host);
  if (ipv4) return isPrivateIPv4(ipv4);
  // An IPv6 literal we cannot parse is refused rather than waved through.
  if (host.includes(":")) return ipv6Words(host) === null || isPrivateIPv6(host);
  return false;
}
