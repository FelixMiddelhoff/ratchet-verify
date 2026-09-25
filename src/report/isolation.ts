import type { IsolationInfo } from "../sandbox/index.js";
import type { RegistryProxyInfo } from "./types.js";

/** One line saying how strongly the installs were isolated, so a report never implies more than was done. */
export function describeIsolation(info: IsolationInfo): string {
  if (info.level === "container") return `container (${[info.runtime, info.image].filter(Boolean).join(", ")}): installs and tests could only see the sandbox directory`;
  return "temp-dir: credentials are withheld, but install scripts can still read host files (use --isolation container)";
}

/** One line for the report footer: which registries went through the proxy and what it did, never a credential. */
export function describeRegistryProxy(info: RegistryProxyInfo): string {
  const registries = info.registries.map((r) => `${r.host} (${r.credential === "none" ? "no credential" : `${r.credential} credential held by the proxy`}${r.scopes?.length ? `, ${r.scopes.join(" ")}` : ""})`).join(", ");
  const parts = [
    `via proxy, credentials never entered the sandbox: ${registries}`,
    info.allowlist === "on" ? `package allowlist on (${info.allowedPackages} names)` : "package allowlist OFF",
    ...(info.allowHosts.length > 0 ? [`extra hosts: ${info.allowHosts.join(", ")}`] : []),
    ...(info.discoveredPackages.length > 0 ? [`discovered dependencies: ${info.discoveredPackages.join(", ")}`] : []),
    `${info.requestsAllowed} requests allowed, ${info.requestsDenied} denied`,
    ...(info.auditTruncated ? ["audit truncated: counts are a lower bound"] : []),
  ];
  return parts.join("; ");
}

/** The evidence behind an escalated verdict; empty when the proxy refused nothing unusual. */
export function describeSuspicious(info: RegistryProxyInfo): string | undefined {
  if (info.suspicious.length === 0) return undefined;
  const items = info.suspicious.map((s) => `${s.count}x ${s.class}: ${s.reason}${s.name ? ` (${s.name})` : ""}`).join("; ");
  return `SUSPICIOUS install activity: the registry proxy refused requests no normal install makes (${items}). An install script may have tried to reach the network through it`;
}
