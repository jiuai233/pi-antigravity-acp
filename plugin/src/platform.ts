import { execFile, execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { promisify } from "node:util";
import { type AgyModelInfo, parseAgyModels } from "./models.ts";

export function resolveBinary(override = process.env.AGY_BINARY): string {
  if (override) return realpathSync(override);
  const command = process.platform === "win32" ? "where.exe" : "which";
  const found = execFileSync(command, [process.platform === "win32" ? "agy.exe" : "agy"], { encoding: "utf8", windowsHide: true, timeout: 5_000 })
    .split(/\r?\n/).find(line => line.trim());
  if (!found) throw new Error("找不到 agy；安装 AGY 或将 AGY_BINARY 指向可执行文件。");
  return realpathSync(found.trim());
}

export function bundledModels(): AgyModelInfo[] {
  return JSON.parse(readFileSync(new URL("../resources/models.json", import.meta.url), "utf8")).models;
}

export async function discoverModels(binary: string): Promise<AgyModelInfo[]> {
  const result = await promisify(execFile)(binary, ["models"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  const models = parseAgyModels(result.stdout);
  if (!models.length) throw new Error("AGY 模型目录为空；请先在 AGY 登录，再刷新模型目录。");
  return models;
}
