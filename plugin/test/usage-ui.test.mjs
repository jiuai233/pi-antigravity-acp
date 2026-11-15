import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAgyQuotaReport, formatResetTime, openAgyUsagePicker, usageBar } from '../src/usage-ui.ts';

test('formatAgyQuotaReport renders groups, bars, reset times, and source', () => {
  const now = new Date(2026, 10, 15, 15, 0, 0);
  const sameDayReset = new Date(2026, 10, 15, 20, 30, 0).getTime();
  const futureReset = new Date(2026, 10, 21, 7, 5, 0).getTime();
  const report = formatAgyQuotaReport({
    capturedAt: now.getTime(),
    source: 'live-acp',
    buckets: [
      { id: 'gemini-5h', label: '5 小时额度', groupLabel: 'Gemini', usedPercent: 10, remainingPercent: 90, windowMinutes: 300, resetsAt: sameDayReset },
      { id: 'gemini-weekly', label: '周额度', groupLabel: 'Gemini', usedPercent: 11.45, remainingPercent: 88.55, windowMinutes: 10080, resetsAt: futureReset },
      { id: 'claude-5h', label: '5 小时额度', groupLabel: 'Claude/GPT', usedPercent: 0, remainingPercent: 100, windowMinutes: 300, resetsAt: null },
    ],
  }, now);

  assert.equal(usageBar(50, 10), '[█████░░░░░]');
  assert.equal(formatResetTime(sameDayReset, now), '20:30');
  assert.match(report, /Gemini/);
  assert.match(report, /5h limit:\s+\[██████████████████░░\] 90% left · resets 20:30/);
  assert.match(report, /Weekly limit:\s+\[██████████████████░░\] 88\.6% left · resets 07:05 on 21 Nov/);
  assert.match(report, /Claude\/GPT/);
  assert.match(report, /100% left/);
  assert.match(report, /Source: live ACP · 15:00:00/);
});

test('openAgyUsagePicker notifies directly when hasUI is false and supports Refresh/Close in non-tui UI mode', async () => {
  const notifications = [];
  let calls = 0;
  const makeSummary = remaining => ({
    capturedAt: Date.now(),
    source: 'seed-acp',
    buckets: [{ id: 'g-5h', label: '5 小时额度', groupLabel: 'Gemini', usedPercent: 100 - remaining, remainingPercent: remaining, windowMinutes: 300, resetsAt: null }],
  });

  await openAgyUsagePicker({
    hasUI: false,
    mode: 'print',
    ui: { notify: (text, level) => notifications.push({ text, level }) },
  }, async () => {
    calls++;
    return makeSummary(95);
  });
  assert.equal(calls, 1);
  assert.equal(notifications.at(-1).level, 'info');
  assert.match(notifications.at(-1).text, /95% left/);

  const prompts = [];
  const choices = ['Refresh', 'Close'];
  await openAgyUsagePicker({
    hasUI: true,
    mode: 'rpc',
    ui: {
      notify: (text, level) => notifications.push({ text, level }),
      select: async (title) => {
        prompts.push(title);
        return choices.shift();
      },
    },
  }, async () => {
    calls++;
    return makeSummary(calls === 2 ? 80 : 75);
  });
  assert.equal(calls, 3);
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /80% left/);
  assert.match(prompts[1], /75% left/);

  await openAgyUsagePicker({
    hasUI: false,
    mode: 'print',
    ui: { notify: (text, level) => notifications.push({ text, level }) },
  }, async () => {
    throw new Error('quota backend offline');
  });
  assert.equal(notifications.at(-1).level, 'error');
  assert.match(notifications.at(-1).text, /quota backend offline/);
});

test('formatAgyQuotaReport labels cached source and openAgyUsagePicker passes forceRefresh only on Refresh', async () => {
  const now = new Date(2026, 10, 15, 15, 5, 0);
  const cachedReport = formatAgyQuotaReport({
    capturedAt: now.getTime(),
    source: 'seed-acp',
    cached: true,
    buckets: [{ id: 'g-5h', label: '5 小时额度', groupLabel: 'Gemini', usedPercent: 20, remainingPercent: 80, windowMinutes: 300, resetsAt: null }],
  }, now);
  assert.match(cachedReport, /Source: seed ACP \(cached\) · 15:05:00/);

  const seenOptions = [];
  const choices = ['Refresh', 'Close'];
  await openAgyUsagePicker({
    hasUI: true,
    mode: 'rpc',
    ui: {
      notify: () => {},
      select: async () => choices.shift(),
    },
  }, async (_signal, options) => {
    seenOptions.push(options);
    return {
      capturedAt: now.getTime(),
      source: 'live-acp',
      cached: !options?.forceRefresh,
      buckets: [{ id: 'g-5h', label: '5 小时额度', groupLabel: 'Gemini', usedPercent: 10, remainingPercent: 90, windowMinutes: 300, resetsAt: null }],
    };
  });
  assert.deepEqual(seenOptions, [{ forceRefresh: false }, { forceRefresh: true }]);
});
