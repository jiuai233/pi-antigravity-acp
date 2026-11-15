import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {BRIDGE_SERVER_NAME} from '../src/bridge/bridge.ts';
import {
  AGY_NATIVE_IDENTITY,
  buildNativeSystemPrompt,
  DEFAULT_NATIVE_PROFILE,
  EVIDENCE_ONLY_V1_PROFILE,
  prepareNativeAgent,
  prepareNativeMcpConfig,
  readNativeProfile,
} from '../src/profile.ts';
import {AcpRuntime, API, PROVIDER} from '../src/runtime.ts';

test('buildNativeSystemPrompt restores AGY <identity> without <guidelines>, strips host harness sections, and keeps rules/addendum/project_context/skills', () => {
  const upstreamPrompt = [
    'You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.',
    '',
    '<tools>',
    '- read: Read file contents',
    '- bash: Execute bash commands',
    '</tools>',
    '',
    '<rules>',
    '- Prefer read/grep/find/ls over bash for file exploration',
    '- Read a file before editing it',
    '- You can inspect PI_* environment variables to understand your runtime context',
    '- Be concise and show file paths clearly',
    '</rules>',
    '',
    '<docs>',
    'Pi documentation (read only when the user asks about pi itself):',
    '- Main documentation: E:\\upstream\\README.md',
    '</docs>',
    '',
    '<addendum>',
    '<行为准则>',
    '保持直接、克制。',
    '</行为准则>',
    '</addendum>',
    '',
    '<project_context>',
    'Working directory: E:\\pi-stack',
    '# AGENTS.md',
    '</project_context>',
    '',
    '<skills>',
    '<skill><name>demo</name></skill>',
    '</skills>',
    '',
    '<cwd>E:\\pi-stack</cwd>',
  ].join('\r\n');

  const built = buildNativeSystemPrompt(upstreamPrompt);
  assert.ok(built.startsWith(AGY_NATIVE_IDENTITY));
  assert.doesNotMatch(built, /<guidelines>/i);
  assert.doesNotMatch(built, /running inside pi/i);
  assert.doesNotMatch(built, /<tools>/);
  assert.doesNotMatch(built, /<docs>/);
  assert.doesNotMatch(built, /Pi documentation/);
  assert.doesNotMatch(built, /PI_\*/);
  assert.doesNotMatch(built, /\r\n/);
  assert.match(built, /Prefer read\/grep\/find\/ls over bash/);
  assert.match(built, /<行为准则>/);
  assert.match(built, /# AGENTS\.md/);
  assert.match(built, /<skills>/);
  assert.match(built, /<cwd>E:\\pi-stack<\/cwd>/);
  assert.equal(buildNativeSystemPrompt(built), built, 'idempotent when <identity> already exists');
});

test('prepareNativeAgent writes schemas outside gemini/ and preserves full tool descriptions under <acp_tool_bridge>/<acp_active_tools>', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'acp-profile-'));
  t.after(() => rm(stateDir, {recursive: true, force: true}));
  const geminiDir = join(stateDir, 'gemini');
  const schemaDir = join(stateDir, 'schemas', BRIDGE_SERVER_NAME);
  await prepareNativeAgent(geminiDir, 'Base prompt', [
    {name: 'obsolete_tool', description: 'Old tool', parameters: {type: 'object', properties: {}}},
  ], BRIDGE_SERVER_NAME, DEFAULT_NATIVE_PROFILE);

  const codemodeDescription = [
    'Run JavaScript that calls other tools. No Node, file system, network, or timers.',
    'Globals:',
    '- `store(key, value)` and `load(key)` keep JSON values across codemode calls.',
    '- `ALL_TOOLS`, `await searchTools(query)`: find unlisted tools.',
  ].join('\n');
  const dispatchDescription = 'Delegate tasks to background workers.\n\nCodemode: `tools.dispatch_prepare(args)` resolves to a string.';
  const agentName = await prepareNativeAgent(geminiDir, 'Base prompt', [
    {
      name: 'codemode',
      description: codemodeDescription,
      parameters: {
        type: 'object',
        required: ['code'],
        properties: {code: {type: 'string'}},
      },
    },
    {
      name: 'dispatch_prepare',
      description: dispatchDescription,
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {type: 'string', enum: ['list', 'template', 'preview', 'submit']},
          route_id: {type: 'string'},
        },
      },
    },
  ], BRIDGE_SERVER_NAME, DEFAULT_NATIVE_PROFILE);

  assert.equal(agentName, 'acp-agent');
  const agentMd = await readFile(join(geminiDir, 'config', 'agents', agentName, 'agent.md'), 'utf8');
  assert.match(agentMd, /^description: Antigravity ACP execution agent\.$/m);
  assert.match(agentMd, /^tools: \[read_file\]$/m);
  assert.match(agentMd, /<identity>/);
  assert.doesNotMatch(agentMd, /<guidelines>/);
  assert.match(agentMd, /<acp_tool_bridge>/);
  assert.match(agentMd, /<acp_active_tools>/);
  assert.doesNotMatch(agentMd, /<pi_/);
  assert.doesNotMatch(agentMd, /pi-acp/);
  assert.match(agentMd, /MCP 服务 "acp-tools"/);
  assert.match(agentMd, /优先通过 `call_mcp_tool` 调用 `codemode`/);
  assert.ok(agentMd.includes(codemodeDescription));
  assert.match(agentMd, /- dispatch_prepare\(action:"list"\|"template"\|"preview"\|"submit", route_id\?\): Delegate tasks to background workers\.\n\nCodemode: `tools\.dispatch_prepare\(args\)` resolves to a string\./);

  const schemaRaw = JSON.parse(await readFile(join(schemaDir, 'dispatch_prepare.json'), 'utf8'));
  assert.equal(schemaRaw.name, 'dispatch_prepare');
  assert.equal(schemaRaw.targetName, 'dispatch_prepare');
  assert.equal(schemaRaw.description, dispatchDescription);
  assert.deepEqual(schemaRaw.parameters.required, ['action']);
  await assert.rejects(readFile(join(schemaDir, 'obsolete_tool.json'), 'utf8'));
});

test('private MCP config preserves long calls and clears inactive servers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-mcp-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const geminiDir = join(dir, 'gemini');
  await prepareNativeMcpConfig(geminiDir, BRIDGE_SERVER_NAME, {url: 'http://127.0.0.1:1234/mcp', token: 'secret'});
  const file = join(geminiDir, 'config', 'mcp_config.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {mcpServers: {'acp-tools': {
    serverUrl: 'http://127.0.0.1:1234/mcp', headers: {'x-pi-bridge-token': 'secret'}, timeoutSeconds: -1,
  }}});
  await prepareNativeMcpConfig(geminiDir, BRIDGE_SERVER_NAME, undefined);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {mcpServers: {}});
});

test('readNativeProfile detects evidence_only_v1 worker envelope and disables read_file', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-dossier-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const pkgPath = join(dir, 'task-package.json');
  await writeFile(pkgPath, JSON.stringify({
    package_id: 'pkg-1',
    agent: {role: 'semantic-review-agent'},
    extensions: {review_execution: {profile: 'evidence_only_v1'}},
  }));

  const profile = readNativeProfile({
    PI_WORKER_TASK_PACKAGE_PATH: pkgPath,
    SUBAGENT_PROJECT_ROOT: dir,
  });
  assert.equal(profile.id, 'evidence_only_v1');

  const geminiDir = join(dir, 'gemini');
  const agentName = await prepareNativeAgent(geminiDir, 'Review prompt', [
    {name: 'read', description: 'Read file', parameters: {type: 'object'}},
    {name: 'submit_review_result', description: 'Submit review', parameters: {type: 'object', required: ['verdict'], properties: {verdict: {type: 'string'}}}},
  ], BRIDGE_SERVER_NAME, profile);
  const agentMd = await readFile(join(geminiDir, 'config', 'agents', agentName, 'agent.md'), 'utf8');
  assert.match(agentMd, /^tools: \[\]$/m);
  assert.match(agentMd, /<acp_tool_bridge>/);
  assert.match(agentMd, /<acp_tool_schemas>/);
  assert.match(agentMd, /<acp_active_tools>/);
  assert.doesNotMatch(agentMd, /<pi_/);
  assert.match(agentMd, /submit_review_result/);
  assert.ok(!agentMd.includes('- read('));
});

test('AcpRuntime grants call_mcp_tool only for active acp-tools and blocks read_file in evidence_only_v1', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'acp-perm-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const prevMonitor = process.env.PI_AGY_NETWORK_MONITOR_CONFIG;
  process.env.PI_AGY_NETWORK_MONITOR_CONFIG = join(dir, 'absent-monitor.json');
  t.after(() => {
    if (prevMonitor === undefined) delete process.env.PI_AGY_NETWORK_MONITOR_CONFIG;
    else process.env.PI_AGY_NETWORK_MONITOR_CONFIG = prevMonitor;
  });

  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => ({trajectory: {steps: [], generatorMetadata: [], metadata: {staticConfig: {}, agentScript: {}}}}),
  }));

  let requestPermission;
  let flightDone;
  const runtime = new AcpRuntime({
    cwd: resolve('.'),
    stateDirectory: dir,
    sessionKey: 'perm-check',
    binary: 'offline-fake-agy',
    readProfile: () => EVIDENCE_ONLY_V1_PROFILE,
    createProcess: async options => {
      requestPermission = options.requestPermission;
      const controller = new AbortController();
      return {
        signal: controller.signal,
        initialize: async () => {},
        getNativeHttpPort: async () => 54321,
        newSession: async () => ({sessionId: 'sess-1', configOptions: [{id: 'model', currentValue: 'm1', options: [{value: 'm1'}]}]}),
        loadSession: async () => ({configOptions: []}),
        setConfigOption: async () => ({configOptions: [{id: 'model', currentValue: 'm1', options: [{value: 'm1'}]}]}),
        prompt: () => new Promise(r => { flightDone = r; }),
        cancel: async () => { flightDone?.({stopReason: 'cancelled'}); },
        closeSession: async () => {},
        close: async () => { controller.abort(); },
      };
    },
  });
  t.after(() => runtime.close());

  const model = {
    id: 'm1', name: 'm1', api: API, provider: PROVIDER, baseUrl: '', reasoning: true,
    input: ['text'], contextWindow: 10000, maxTokens: 1000, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
  };
  const stream = runtime.stream(model, {
    messages: [
      {
        role: 'system',
        content: 'Closed dossier',
        toolsAdded: [
          {name: 'read', description: 'Disallowed', parameters: {type: 'object'}},
          {name: 'submit_review_result', description: 'Allowed', parameters: {type: 'object'}},
        ],
        timestamp: 0,
      },
      {role: 'user', content: 'Review now', timestamp: 1},
    ],
  });

  while (!flightDone) await new Promise(r => setImmediate(r));
  const options = [{optionId: 'allow_once', kind: 'allow_once', name: 'Allow'}];

  const allowed = requestPermission({
    sessionId: 'sess-1',
    toolCall: {toolCallId: 'c1', name: 'call_mcp_tool', rawInput: {ServerName: 'acp-tools', ToolName: 'submit_review_result'}},
    options,
  });
  assert.deepEqual(allowed, {outcome: {outcome: 'selected', optionId: 'allow_once'}});

  assert.deepEqual(requestPermission({
    sessionId: 'sess-1', toolCall: {toolCallId: 'missing-target', name: 'call_mcp_tool'}, options,
  }), {outcome: {outcome: 'cancelled'}});

  const wrongTool = requestPermission({
    sessionId: 'sess-1',
    toolCall: {toolCallId: 'c2', name: 'call_mcp_tool', rawInput: {ServerName: 'acp-tools', ToolName: 'read'}},
    options,
  });
  assert.deepEqual(wrongTool, {outcome: {outcome: 'cancelled'}});

  const wrongServer = requestPermission({
    sessionId: 'sess-1',
    toolCall: {toolCallId: 'c3', name: 'call_mcp_tool', rawInput: {ServerName: 'pi-acp', ToolName: 'submit_review_result'}},
    options,
  });
  assert.deepEqual(wrongServer, {outcome: {outcome: 'cancelled'}});

  const blockedRead = requestPermission({
    sessionId: 'sess-1',
    toolCall: {toolCallId: 'c4', name: 'read_file', kind: 'read'},
    options,
  });
  assert.deepEqual(blockedRead, {outcome: {outcome: 'cancelled'}});

  flightDone({stopReason: 'end_turn'});
  await stream.result();
});
