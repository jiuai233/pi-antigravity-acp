import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGY_ACP_QUOTA_BRIDGE_SYMBOL,
  ensureAgyQuotaBridge,
  parseAgyQuotaSummary,
  queryAntigravityQuota,
  registerLiveAcpRuntime,
  touchLiveAcpRuntime,
  unregisterLiveAcpRuntime,
} from "../src/quota.ts";

test("parseAgyQuotaSummary orders Gemini then Claude/GPT and normalizes 5h/weekly windows", () => {
  const summary = parseAgyQuotaSummary(
    {
      groups: [
        {
          displayName: "Claude & GPT Models",
          buckets: [
            {
              bucketId: "claude_weekly",
              displayName: "Weekly Limit",
              remaining: { case: "remainingFraction", value: 0.4 },
              resetTime: "2026-11-20T00:00:00Z",
            },
            {
              bucketId: "claude_session",
              displayName: "5-Hour Limit",
              remainingFraction: 0.75,
              resetTime: 1794700000,
            },
            {
              bucketId: "disabled_bucket",
              disabled: true,
              remainingFraction: 0.1,
            },
          ],
        },
        {
          displayName: "Gemini Models",
          buckets: [
            {
              bucketId: "gemini-5h",
              remaining: { remainingFraction: "0.9" },
              resetTime: "1794680000",
            },
            {
              bucketId: "gemini-7d",
              remainingFraction: 0,
              resetTime: 1795000000000,
            },
          ],
        },
      ],
    },
    1794646000000,
    "live-acp",
  );

  assert.equal(summary.source, "live-acp");
  assert.equal(summary.capturedAt, 1794646000000);
  assert.deepEqual(
    summary.buckets.map((bucket) => ({
      id: bucket.id,
      groupLabel: bucket.groupLabel,
      label: bucket.label,
      usedPercent: bucket.usedPercent,
      remainingPercent: bucket.remainingPercent,
      windowMinutes: bucket.windowMinutes,
      resetsAt: bucket.resetsAt,
    })),
    [
      {
        id: "gemini-gemini-5h",
        groupLabel: "Gemini",
        label: "5 小时额度",
        usedPercent: 10,
        remainingPercent: 90,
        windowMinutes: 300,
        resetsAt: 1794680000000,
      },
      {
        id: "gemini-gemini-7d",
        groupLabel: "Gemini",
        label: "周额度",
        usedPercent: 100,
        remainingPercent: 0,
        windowMinutes: 10080,
        resetsAt: 1795000000000,
      },
      {
        id: "claude-gpt-claude-session",
        groupLabel: "Claude/GPT",
        label: "5 小时额度",
        usedPercent: 25,
        remainingPercent: 75,
        windowMinutes: 300,
        resetsAt: 1794700000000,
      },
      {
        id: "claude-gpt-claude-weekly",
        groupLabel: "Claude/GPT",
        label: "周额度",
        usedPercent: 60,
        remainingPercent: 40,
        windowMinutes: 10080,
        resetsAt: Date.parse("2026-11-20T00:00:00Z"),
      },
    ],
  );
});

test("queryAntigravityQuota reuses most recently touched live runtime with zero process spawns", async (t) => {
  let olderCalls = 0;
  let newerCalls = 0;
  let spawned = 0;

  const olderRuntime = {
    hasLiveNativeControl: () => true,
    readQuotaSummary: async () => {
      olderCalls += 1;
      return { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "session", remainingFraction: 0.2 }] }] };
    },
  };
  const newerRuntime = {
    hasLiveNativeControl: () => true,
    readQuotaSummary: async () => {
      newerCalls += 1;
      return { groups: [{ displayName: "Gemini", buckets: [{ bucketId: "session", remainingFraction: 0.8 }] }] };
    },
  };

  registerLiveAcpRuntime(olderRuntime);
  registerLiveAcpRuntime(newerRuntime);
  touchLiveAcpRuntime(olderRuntime);
  t.after(() => {
    unregisterLiveAcpRuntime(olderRuntime);
    unregisterLiveAcpRuntime(newerRuntime);
  });

  const bridge = ensureAgyQuotaBridge();
  assert.equal(globalThis[AGY_ACP_QUOTA_BRIDGE_SYMBOL], bridge);
  assert.equal(bridge.hasLiveRuntime(), true);

  const result = await queryAntigravityQuota({
    allowColdSeed: true,
    createProcess: async () => {
      spawned += 1;
      throw new Error("should not spawn cold seed when live runtime exists");
    },
  });

  assert.equal(result.source, "live-acp");
  assert.equal(result.buckets[0].usedPercent, 80);
  assert.equal(olderCalls, 1);
  assert.equal(newerCalls, 0);
  assert.equal(spawned, 0);
});

test("queryAntigravityQuota respects allowColdSeed=false and cleans up seed .pb/.db on cold seed", async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), "pi-acp-quota-seed-"));
  t.after(() => rm(stateRoot, { recursive: true, force: true }));

  await assert.rejects(
    () => queryAntigravityQuota({ allowColdSeed: false, stateRoot }),
    /No active Antigravity ACP runtime/,
  );

  t.mock.method(globalThis, "fetch", async (url) => {
    assert.match(String(url), /RetrieveUserQuotaSummary$/);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        groups: [
          {
            displayName: "Gemini",
            buckets: [{ bucketId: "session", remainingFraction: 0.65, resetTime: 1794680000 }],
          },
        ],
      }),
    };
  });

  let createCount = 0;
  let closedSessions = [];
  const seedSessionId = "seed-conv-1234";

  const createProcess = async (opts) => {
    createCount += 1;
    const convDir = path.join(opts.geminiDir, "antigravity-cli", "conversations");
    await mkdir(convDir, { recursive: true });
    return {
      initialize: async () => {},
      newSession: async () => {
        await writeFile(path.join(convDir, `${seedSessionId}.pb`), "seed-pb");
        await writeFile(path.join(convDir, `${seedSessionId}.db`), "seed-db");
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { sessionId: seedSessionId };
      },
      getNativeHttpPort: async () => 43210,
      closeSession: async (id) => {
        closedSessions.push(id);
      },
      close: async () => {},
    };
  };

  const [r1, r2] = await Promise.all([
    queryAntigravityQuota({ allowColdSeed: true, stateRoot, binary: "fake-agy", env: {}, createProcess }),
    queryAntigravityQuota({ allowColdSeed: true, stateRoot, binary: "fake-agy", env: {}, createProcess }),
  ]);

  assert.equal(createCount, 1, "concurrent cold seed requests must coalesce into single flight");
  assert.equal(r1.source, "seed-acp");
  assert.equal(r2.source, "seed-acp");
  assert.equal(r1.buckets[0].usedPercent, 35);
  assert.deepEqual(closedSessions, [seedSessionId]);

  const convDir = path.join(stateRoot, "_quota-seed", "gemini", "antigravity-cli", "conversations");
  await assert.rejects(() => access(path.join(convDir, `${seedSessionId}.pb`)));
  await assert.rejects(() => access(path.join(convDir, `${seedSessionId}.db`)));
});
