import { readFileSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";

// Pi 1.5.2's Jiti alias for the root pi-ai view incorrectly also prefixes
// public subpath imports. Resolve the host peer's declared export natively.
const manifest = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(path.join(getPackageDir(), "package.json")).href);
if (!manifest) throw new Error("Cannot resolve the host Pi AI package for native history conversion.");
const file = realpathSync(manifest);
const exports = JSON.parse(readFileSync(file, "utf8")).exports;
const target = exports["./api/*"].import.replace("*", "transform-messages");
export const { transformMessages } = await import(pathToFileURL(path.resolve(path.dirname(file), target)).href) as
  typeof import("@earendil-works/pi-ai/api/transform-messages");
