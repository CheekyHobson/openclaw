/**
 * Validates page navigation URLs and redirect chains before or after browser
 * navigation while accounting for browser proxy routing.
 */
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { resolveGatewayPublicOrigin } from "openclaw/plugin-sdk/config-contracts";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  isPrivateNetworkAllowedByPolicy,
  matchesHostnameAllowlist,
  normalizeHostname,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "openclaw/plugin-sdk/security-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
// Keep non-network navigation explicit; about:blank is the only bootstrap URL.
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);
const BROWSER_NAVIGATION_CREDENTIALS_BLOCKED_MESSAGE =
  "Navigation blocked: URL-embedded credentials are not supported for page navigation. Set HTTP Basic auth with `openclaw browser set credentials <username> <password>` or use an authenticated browser profile.";

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

function browserUrlUsesGatewayPort(url: URL): boolean {
  return (
    Number(url.port || (url.protocol === "https:" ? 443 : 80)) ===
    resolveGatewayPort(getRuntimeConfigSnapshot() ?? undefined)
  );
}

/** Keep this Gateway's human decision surface out of its browser automation. */
function assertBrowserControlUiOriginAllowed(
  rawUrl: string,
  resolvedAddresses: readonly string[] = [],
): void {
  const url = URL.parse(rawUrl);
  if (!url || !NETWORK_NAVIGATION_PROTOCOLS.has(url.protocol)) {
    return;
  }
  const config = getRuntimeConfigSnapshot();
  const gateway = config?.gateway;
  const origins = [
    resolveGatewayPublicOrigin(config),
    ...(gateway?.controlUi?.allowedOrigins ?? []),
    gateway?.remote?.url,
  ];
  const configuredOrigin = origins.some((origin) => {
    const parsed = origin ? URL.parse(origin) : null;
    if (!parsed) {
      return false;
    }
    if (parsed.protocol === "ws:" || parsed.protocol === "wss:") {
      parsed.protocol = parsed.protocol === "wss:" ? "https:" : "http:";
    }
    return parsed.origin === url.origin;
  });
  const hosts = [url.hostname, ...resolvedAddresses].map(normalizeHostname);
  const localOrigin =
    browserUrlUsesGatewayPort(url) &&
    (hosts.some(
      (host) =>
        isLoopbackHost(host) ||
        host === "0.0.0.0" ||
        host === normalizeHostname(gateway?.customBindHost ?? ""),
    ) ||
      Object.values(networkInterfaces()).some((addresses) =>
        addresses?.some((address) => hosts.includes(normalizeHostname(address.address))),
      ));
  if (configuredOrigin || localOrigin) {
    throw new InvalidBrowserNavigationUrlError(
      "OpenClaw browser automation cannot access this Gateway's Control UI; ask the user to operate it.",
    );
  }
}

/** Tab management checks local aliases without imposing navigation's SSRF policy. */
export async function assertBrowserControlUiTabAllowed(
  rawUrl: string,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  assertBrowserControlUiOriginAllowed(rawUrl);
  const url = URL.parse(rawUrl);
  if (
    !url ||
    !NETWORK_NAVIGATION_PROTOCOLS.has(url.protocol) ||
    !browserUrlUsesGatewayPort(url) ||
    isIP(normalizeHostname(url.hostname)) !== 0
  ) {
    return;
  }
  const resolved = await resolvePinnedHostnameWithPolicy(url.hostname, {
    policy: { dangerouslyAllowPrivateNetwork: true },
    signal: options.signal,
  });
  assertBrowserControlUiOriginAllowed(rawUrl, resolved.addresses);
}

/** Reject credentials and the Control UI before any navigation transport dispatch. */
export function parseBrowserNavigationUrl(url: string): URL {
  const rawUrl = url.trim();
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  const parsed = URL.parse(rawUrl);
  if (!parsed) {
    const diagnostic = rawUrl.includes("@") ? "[redacted credential-bearing URL]" : rawUrl;
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${diagnostic}`);
  }

  if (parsed.username || parsed.password) {
    throw new InvalidBrowserNavigationUrlError(BROWSER_NAVIGATION_CREDENTIALS_BLOCKED_MESSAGE);
  }
  assertBrowserControlUiOriginAllowed(parsed.href);
  return parsed;
}

export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
  browserProxyMode?: BrowserNavigationProxyMode;
};

/** Describes whether the browser itself is routing page traffic through a proxy. */
export type BrowserNavigationProxyMode = "direct" | "explicit-browser-proxy";

/** Minimal request shape used to walk browser redirect chains. */
type BrowserNavigationRequestLike = {
  url(): string;
  redirectedFrom(): BrowserNavigationRequestLike | null;
};

/** Build a navigation-policy object while omitting default direct proxy mode. */
export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
  opts?: { browserProxyMode?: BrowserNavigationProxyMode },
): BrowserNavigationPolicyOptions {
  return {
    ...(ssrfPolicy ? { ssrfPolicy } : {}),
    ...(opts?.browserProxyMode && opts.browserProxyMode !== "direct"
      ? { browserProxyMode: opts.browserProxyMode }
      : {}),
  };
}

/** Return true when a URL needs redirect inspection under strict policy. */
export function requiresInspectableBrowserNavigationRedirectsForUrl(
  url: string,
  ssrfPolicy?: SsrFPolicy,
): boolean {
  if (ssrfPolicy?.dangerouslyAllowPrivateNetwork !== false) {
    return false;
  }
  return NETWORK_NAVIGATION_PROTOCOLS.has(URL.parse(url)?.protocol ?? "");
}

function isExplicitlyAllowedBrowserHostname(hostname: string, ssrfPolicy?: SsrFPolicy): boolean {
  const normalizedHostname = normalizeHostname(hostname);
  const allowedHostnames = (ssrfPolicy?.allowedHostnames ?? [])
    .map((pattern) => normalizeHostname(pattern))
    .filter(Boolean);
  return allowedHostnames.length > 0
    ? matchesHostnameAllowlist(normalizedHostname, allowedHostnames)
    : false;
}

/** Assert that a requested browser navigation URL is policy-allowed. */
export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  opts.signal?.throwIfAborted();
  const parsed = parseBrowserNavigationUrl(opts.url);

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (SAFE_NON_NETWORK_URLS.has(parsed.href)) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }

  // Browser proxy routing hides the final connect target from this process.
  // Only block when the browser profile is known to be proxy-routed; Gateway
  // provider proxy env alone is not proof of browser page proxy behavior.
  if (
    opts.browserProxyMode === "explicit-browser-proxy" &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy cannot be enforced while this browser profile is proxy-routed",
    );
  }

  // Browser navigations happen in Chromium's network stack, not Node's. In
  // strict mode, a hostname-based URL would be resolved twice by different
  // resolvers, so Node-side pinning cannot guarantee the browser connects to
  // the same address that passed policy checks.
  if (
    opts.ssrfPolicy &&
    opts.ssrfPolicy.dangerouslyAllowPrivateNetwork === false &&
    !isPrivateNetworkAllowedByPolicy(opts.ssrfPolicy) &&
    isIP(normalizeHostname(parsed.hostname)) === 0 &&
    !isExplicitlyAllowedBrowserHostname(parsed.hostname, opts.ssrfPolicy)
  ) {
    throw new InvalidBrowserNavigationUrlError(
      "Navigation blocked: strict browser SSRF policy requires an IP-literal URL because browser DNS rebinding protections are unavailable for hostname-based navigation",
    );
  }

  const resolved = await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
    signal: opts.signal,
  });
  // Config can change while DNS is pending; use the published owner again before dispatch.
  assertBrowserControlUiOriginAllowed(parsed.href, resolved.addresses);
}

/**
 * Best-effort post-navigation guard for final page URLs.
 * Only validates network URLs (http/https) and about:blank to avoid false
 * positives on browser-internal error pages (e.g. chrome-error://). In strict
 * mode this intentionally re-applies the hostname gate after redirects.
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  opts.signal?.throwIfAborted();
  const rawUrl = opts.url.trim();
  if (!rawUrl) {
    return;
  }
  const parsed = URL.parse(rawUrl);
  if (!parsed) {
    return;
  }
  if (NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) || SAFE_NON_NETWORK_URLS.has(parsed.href)) {
    await assertBrowserNavigationAllowed(opts);
  }
}

/** Assert that every URL in a browser redirect chain is policy-allowed. */
export async function assertBrowserNavigationRedirectChainAllowed(
  opts: {
    request?: BrowserNavigationRequestLike | null;
    lookupFn?: LookupFn;
    signal?: AbortSignal;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  opts.signal?.throwIfAborted();
  const chain: string[] = [];
  let current = opts.request ?? null;
  while (current) {
    chain.push(current.url());
    current = current.redirectedFrom();
  }
  for (const url of chain.toReversed()) {
    await assertBrowserNavigationAllowed({
      url,
      lookupFn: opts.lookupFn,
      ssrfPolicy: opts.ssrfPolicy,
      browserProxyMode: opts.browserProxyMode,
      signal: opts.signal,
    });
  }
}
