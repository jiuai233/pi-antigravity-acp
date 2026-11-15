import { existsSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..", "..");
const localRequire = createRequire(import.meta.url);

function hasRepoLocalHostPackage() {
  try {
    const resolved = localRequire.resolve("@earendil-works/pi-coding-agent/package.json");
    const rel = path.relative(repoRoot, resolved);
    return !rel.startsWith("..") && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function findHostAnchors() {
  if (hasRepoLocalHostPackage()) return [];
  const hostDir = process.env.PI_HOST_PACKAGE_ROOT;
  if (!hostDir) return [];
  const pkgPath = path.join(hostDir, "package.json");
  if (!existsSync(pkgPath)) return [];
  return [
    pathToFileURL(pkgPath).href,
    pathToFileURL(path.resolve(hostDir, "..", "..", "__pi_host_anchor__.js")).href,
  ];
}

const hostAnchors = findHostAnchors();

if (hostAnchors.length > 0) {
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!specifier.startsWith("@earendil-works/")) {
        return nextResolve(specifier, context);
      }
      let lastError;
      for (const parentURL of hostAnchors) {
        try {
          return nextResolve(specifier, { ...context, parentURL });
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      return nextResolve(specifier, context);
    },
  });
}
