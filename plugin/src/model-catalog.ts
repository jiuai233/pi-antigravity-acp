// ACP-owned success cache; discovery never replaces a working catalog on failure.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { type AgyModelInfo, mergeAgyModels } from "./models.ts";
import { bundledModels, discoverModels, resolveBinary } from "./platform.ts";

export interface ModelCache {
  fetchedAt?: number;
  source: "live" | "fallback";
  models: AgyModelInfo[];
  discoveryError?: unknown;
  cacheWriteError?: unknown;
}
export interface ModelCatalogIo {
  readCache(): ModelCache | null;
  writeCache(cache: ModelCache): void;
  listModels(): Promise<AgyModelInfo[]>;
}

export function defaultModelCatalogIo(directory: string): ModelCatalogIo {
  const file = path.join(directory, "model-list.json");
  return {
    readCache: () => {
      try { return JSON.parse(readFileSync(file, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    },
    writeCache: cache => {
      mkdirSync(directory, { recursive: true });
      const temporary = `${file}.${process.pid}.tmp`;
      writeFileSync(temporary, JSON.stringify(cache, null, 2));
      renameSync(temporary, file);
    },
    listModels: () => discoverModels(resolveBinary()),
  };
}

export class ModelCatalog {
  private value: ModelCache;
  private refreshing?: Promise<ModelCache>;
  readonly io: ModelCatalogIo;
  loadedFrom: "disk" | "bundled" = "bundled";
  cacheReadError?: unknown;

  constructor(directory: string, io: ModelCatalogIo = defaultModelCatalogIo(directory)) {
    this.io = io;
    this.value = { source: "fallback", models: bundledModels() };
    try {
      const cached = io.readCache();
      if (cached) {
        if (cached.source !== "live" || !Number.isFinite(cached.fetchedAt) || !Array.isArray(cached.models)
          || !cached.models.length || cached.models.some(model => typeof model.id !== "string" || !model.id
            || typeof model.name !== "string" || !Array.isArray(model.supportedEfforts))) {
          throw new Error("ACP 模型缓存格式无效；将重新发现模型目录。");
        }
        this.value = { source: "live", fetchedAt: cached.fetchedAt, models: mergeAgyModels(cached.models) };
        this.loadedFrom = "disk";
      }
    } catch (error) { this.cacheReadError = error; }
  }

  get cache(): ModelCache { return this.value; }
  get models(): AgyModelInfo[] { return this.value.models; }
  isFresh(): boolean {
    // Successful live discoveries are reusable; bundled fallback has no success time.
    const { source, fetchedAt } = this.value;
    return source === "live" && fetchedAt !== undefined && Date.now() - fetchedAt < 24 * 60 * 60 * 1000;
  }

  refresh(): Promise<ModelCache> {
    this.refreshing ??= this.discover().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async discover(): Promise<ModelCache> {
    const previous = this.value;
    let models: AgyModelInfo[];
    try {
      models = mergeAgyModels(await this.io.listModels());
      if (!models.length) throw new Error("AGY 模型目录为空；请先在 AGY 登录，再刷新模型目录。");
    } catch (discoveryError) {
      this.value = { ...previous, discoveryError };
      return this.value;
    }
    const cache: ModelCache = { fetchedAt: Date.now(), source: "live", models };
    try { this.io.writeCache(cache); }
    catch (error) { cache.cacheWriteError = error; }
    this.value = cache;
    return cache;
  }

  diagnostics(): object {
    const message = (error: unknown) => error === undefined ? undefined : error instanceof Error ? error.message : String(error);
    return { source: this.value.source, loadedFrom: this.loadedFrom, fetchedAt: this.value.fetchedAt,
      fresh: this.isFresh(), count: this.models.length, refreshing: Boolean(this.refreshing),
      discoveryError: message(this.value.discoveryError), cacheReadError: message(this.cacheReadError),
      cacheWriteError: message(this.value.cacheWriteError) };
  }
}
