import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface AgyNetworkMonitor {
  /** Spawn-only copy, including the caller's proxy intent. Never log this object. */
  env: NodeJS.ProcessEnv;
  warning?: string;
}

const previous = new Map<string, NodeJS.ProcessEnv>();
const TRANSPORT_KEYS = new Set([
  "http_proxy", "https_proxy", "all_proxy", "no_proxy", "ssl_cert_file", "ssl_cert_dir", "godebug",
]);

/** Optional observation must not veto generation or silently switch a proxy to direct. */
export function readAgyNetworkMonitor(parentEnv: NodeJS.ProcessEnv = process.env): AgyNetworkMonitor {
  const configPath = parentEnv.PI_AGY_NETWORK_MONITOR_CONFIG
    ?? join(getAgentDir(), "antigravity", "network-monitor", "config.json");
  const retained = (): NodeJS.ProcessEnv => ({ ...parentEnv, ...previous.get(configPath) });
  const warn = (message: string): AgyNetworkMonitor => ({
    env: retained(), warning: `AGY network monitor (${configPath}): ${message}; retaining prior transport overrides or inherited environment.`,
  });
  let config: any;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && !previous.has(configPath)) return { env: { ...parentEnv } };
    return warn(error instanceof SyntaxError ? "invalid JSON" : "configuration unavailable");
  }
  if (config?.enabled === false) {
    previous.delete(configPath);
    return { env: { ...parentEnv } };
  }
  if (config?.enabled !== true) return warn("enabled is not a boolean");
  const env = retained();
  const overrides: NodeJS.ProcessEnv = { ...previous.get(configPath) };
  // Pass configured values to Go. Do not preflight URLs, PEMs or file identities.
  const fields = { proxyUrl: ["HTTP_PROXY", "HTTPS_PROXY"],
    caBundlePath: ["SSL_CERT_FILE"], certificateDirectory: ["SSL_CERT_DIR"] };
  const missing: string[] = [];
  for (const [field, keys] of Object.entries(fields)) {
    if (typeof config[field] !== "string" || !config[field]) { missing.push(field); continue; }
    for (const key of keys) overrides[key] = config[field];
  }
  overrides.NO_PROXY = "localhost,127.0.0.1,::1";
  const goDebug = (env.GODEBUG ?? env.godebug ?? "").split(",")
    .filter(entry => entry && entry.split("=", 1)[0].trim() !== "x509sslcertoverrideplatform");
  overrides.GODEBUG = [...goDebug, "x509sslcertoverrideplatform=1"].join(",");
  // Only explicit monitor values replace inherited keys; absent fields keep user intent.
  for (const key of Object.keys(env)) {
    if (TRANSPORT_KEYS.has(key.toLowerCase()) && Object.keys(overrides).some(name => name.toLowerCase() === key.toLowerCase())) delete env[key];
  }
  previous.set(configPath, overrides);
  return { env: { ...env, ...overrides }, ...(missing.length ? {
    warning: `AGY network monitor: missing ${missing.join(", ")}; retaining existing values for those fields.`,
  } : {}) };
}
