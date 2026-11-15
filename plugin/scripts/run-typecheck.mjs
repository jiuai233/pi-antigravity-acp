import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptsDir, "..");
const repoRoot = path.resolve(pluginRoot, "..");
const req = createRequire(import.meta.url);

function findTsc() {
  if (process.env.PI_ACP_TSC_BIN && existsSync(process.env.PI_ACP_TSC_BIN)) {
    return process.env.PI_ACP_TSC_BIN;
  }
  const localCandidates = [
    path.join(pluginRoot, "node_modules", "typescript", "bin", "tsc"),
    path.join(repoRoot, "node_modules", "typescript", "bin", "tsc"),
  ];
  for (const candidate of localCandidates) {
    if (existsSync(candidate)) return candidate;
  }
  try {
    return req.resolve("typescript/bin/tsc");
  } catch {
    // Fall back to PATH / global npm root.
  }
  try {
    const cmd = process.platform === "win32" ? "where.exe" : "which";
    const found = execFileSync(cmd, ["tsc"], { encoding: "utf8", windowsHide: true })
      .split(/\r?\n/)
      .find((line) => line.trim());
    if (found) return found.trim();
  } catch {
    // Ignore missing tsc in PATH.
  }
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
    const globalTsc = path.join(globalRoot, "typescript", "bin", "tsc");
    if (existsSync(globalTsc)) return globalTsc;
  } catch {
    // Ignore missing global tsc.
  }
  return undefined;
}

function findHostPackageRoot() {
  try {
    const resolved = req.resolve("@earendil-works/pi-coding-agent/package.json");
    const rel = path.relative(repoRoot, resolved);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) return undefined;
  } catch {
    // Not installed locally in repo; resolve global Pi host.
  }
  if (process.env.PI_HOST_PACKAGE_ROOT && existsSync(path.join(process.env.PI_HOST_PACKAGE_ROOT, "package.json"))) {
    return process.env.PI_HOST_PACKAGE_ROOT;
  }
  const prefixGuess = path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  if (existsSync(path.join(prefixGuess, "package.json"))) return prefixGuess;
  try {
    const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", windowsHide: true }).trim();
    const candidate = path.join(globalRoot, "@earendil-works", "pi-coding-agent");
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
  } catch {
    return undefined;
  }
  return undefined;
}

const tsc = findTsc();
if (!tsc) {
  console.error("未找到 tsc。请安装全局 typescript，或在 plugin/ 执行 npm install --include=dev 后重试。");
  process.exit(1);
}

const hostRoot = findHostPackageRoot();
let tmpDir;
try {
  let tsconfigPath = path.join(pluginRoot, "tsconfig.json");
  if (hostRoot) {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "pi-acp-tsc-"));
    tsconfigPath = path.join(tmpDir, "tsconfig.json");
    const piAiDist = path.join(hostRoot, "node_modules", "@earendil-works", "pi-ai", "dist");
    const piTuiDist = path.join(hostRoot, "node_modules", "@earendil-works", "pi-tui", "dist");
    const hostTypes = path.join(hostRoot, "node_modules", "@types");
    writeFileSync(
      tsconfigPath,
      JSON.stringify(
        {
          extends: path.join(pluginRoot, "tsconfig.json"),
          compilerOptions: {
            typeRoots: [
              path.join(repoRoot, "node_modules", "@types"),
              path.join(pluginRoot, "node_modules", "@types"),
              hostTypes,
            ],
            paths: {
              "@earendil-works/pi-coding-agent": [path.join(hostRoot, "dist", "index.d.ts")],
              "@earendil-works/pi-ai": [path.join(piAiDist, "index.d.ts")],
              "@earendil-works/pi-ai/*": [path.join(piAiDist, "*.d.ts")],
              "@earendil-works/pi-tui": [path.join(piTuiDist, "index.d.ts")],
            },
          },
          include: [path.join(pluginRoot, "index.ts"), path.join(pluginRoot, "src/**/*.ts")],
        },
        null,
        2,
      ),
    );
  }
  const isJs = tsc.endsWith(".js") || tsc.endsWith(".cjs") || tsc.endsWith(".mjs");
  const result = isJs
    ? spawnSync(process.execPath, [tsc, "-p", tsconfigPath, "--noEmit"], { cwd: pluginRoot, stdio: "inherit" })
    : spawnSync(tsc, ["-p", tsconfigPath, "--noEmit"], { cwd: pluginRoot, stdio: "inherit" });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
} finally {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
}
