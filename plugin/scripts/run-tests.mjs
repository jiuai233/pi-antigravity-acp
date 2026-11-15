import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptsDir, "..");
const testDir = path.join(pluginRoot, "test");
const hookUrl = pathToFileURL(path.join(scriptsDir, "resolve-host-peers.mjs")).href;

function resolveHostPackageRoot() {
  try {
    const req = createRequire(import.meta.url);
    return path.dirname(req.resolve("@earendil-works/pi-coding-agent/package.json"));
  } catch {
    if (process.env.PI_HOST_PACKAGE_ROOT && existsSync(path.join(process.env.PI_HOST_PACKAGE_ROOT, "package.json"))) {
      return process.env.PI_HOST_PACKAGE_ROOT;
    }
    const prefixGuess = path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
    if (existsSync(path.join(prefixGuess, "package.json"))) {
      return prefixGuess;
    }
    try {
      const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
      const candidate = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
      if (existsSync(path.join(candidate, "package.json"))) return candidate;
    } catch {
      // Fall through and let tests fail normally if no host packages exist.
    }
    return undefined;
  }
}

const userArgs = process.argv.slice(2);
const hasExplicitTests = userArgs.some((arg) => !arg.startsWith("-"));
const testFiles = hasExplicitTests
  ? []
  : readdirSync(testDir)
      .filter((name) => name.endsWith(".test.mjs"))
      .sort()
      .map((name) => path.join("test", name));

const hostRoot = resolveHostPackageRoot();
const env = { ...process.env };
if (hostRoot) {
  env.PI_HOST_PACKAGE_ROOT = hostRoot;
  env.PI_STACK_PI_ROOT ??= hostRoot;
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${hookUrl}`].filter(Boolean).join(" ");
}

const result = spawnSync(
  process.execPath,
  ["--experimental-strip-types", "--test", ...userArgs, ...testFiles],
  { cwd: pluginRoot, env, stdio: "inherit" },
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
