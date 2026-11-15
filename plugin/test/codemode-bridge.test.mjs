// Real installed Pi SDK, real QuickJS codemode, real AcpRuntime + prepareNativeAgent + loopback MCP; no external model request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire, findPackageJSON } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { toJson } from '@bufbuild/protobuf';
import { buildNativeHistory, nativeTrajectorySchema } from '../src/history.ts';
import { AcpRuntime, API, PROVIDER } from '../src/runtime.ts';

function hasRuntimeDeps(candidate) {
  try {
    if (!candidate || !fs.existsSync(path.join(candidate, 'package.json'))) return false;
    const req = createRequire(path.join(candidate, 'package.json'));
    req.resolve('typebox');
    req.resolve('quickjs-wasi');
    return true;
  } catch {
    return false;
  }
}

function resolveSdkRoot() {
  const candidates = [];
  if (process.env.PI_STACK_PI_ROOT) candidates.push(path.resolve(process.env.PI_STACK_PI_ROOT));
  try {
    const pkg = findPackageJSON('@earendil-works/pi-coding-agent', import.meta.url);
    if (pkg) candidates.push(path.dirname(pkg));
  } catch {}
  candidates.push(
    path.resolve(import.meta.dirname, '../../../apps/piweb/web/node_modules/@earendil-works/pi-coding-agent'),
    path.join(os.homedir(), '.pi-stack/current/app.piweb/web/node_modules/@earendil-works/pi-coding-agent'),
  );
  for (const candidate of candidates) {
    if (hasRuntimeDeps(candidate)) return candidate;
  }
  throw new Error('Cannot locate a complete @earendil-works/pi-coding-agent installation (with typebox + quickjs-wasi) for codemode E2E test');
}

const sdkRoot = resolveSdkRoot();
const hostRequire = createRequire(path.join(sdkRoot, 'package.json'));
const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } =
  await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
const { createCodemodeExtension } =
  await import(pathToFileURL(path.join(sdkRoot, 'dist/extensions/codemode/index.js')).href);
const { Type } = await import(pathToFileURL(hostRequire.resolve('typebox')).href);

for (const mode of ['on', 'only']) {
  test(`ACP SDK codemode (${mode}): batch reads, full contract, mid-turn dynamic tool discovery, and call_mcp_tool history import`, { timeout: 30000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `agy-acp-codemode-${mode}-`));
    const previousMonitor = process.env.PI_AGY_NETWORK_MONITOR_CONFIG;
    process.env.PI_AGY_NETWORK_MONITOR_CONFIG = path.join(root, 'absent-monitor.json');

    const nativeServer = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.endsWith('/GetCascadeTrajectory')) {
        res.end(JSON.stringify({
          trajectory: {
            steps: [{ status: 'CORTEX_STEP_STATUS_DONE' }],
            generatorMetadata: [],
            metadata: {
              staticConfig: { agentConfig: { mixinConfig: { tools: [{ name: 'read_file', builtin: true }] } } },
              agentScript: { name: 'acp-agent' },
            },
          },
        }));
        return;
      }
      res.end('{}');
    });
    await new Promise(resolve => nativeServer.listen(0, '127.0.0.1', resolve));
    const nativePort = nativeServer.address().port;

    let session;
    let runtime;
    try {
      const agentDir = path.join(root, 'agent');
      fs.mkdirSync(agentDir, { recursive: true });
      fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
      fs.writeFileSync(path.join(root, 'a.txt'), 'FIRST_READ_EXACT');
      fs.writeFileSync(path.join(root, 'b.txt'), 'SECOND_READ_EXACT');

      const modelRuntime = await ModelRuntime.create({
        authPath: path.join(agentDir, 'auth.json'),
        modelsPath: null,
        refreshOnCreate: false,
      });
      modelRuntime.registerProvider(PROVIDER, {
        api: API,
        apiKey: 'offline-fixture',
        baseUrl: 'agy://native-acp',
        models: [{
          id: 'tool-flow',
          name: 'Offline AGY ACP tool flow',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 4096,
        }],
      });

      const settingsManager = SettingsManager.inMemory({
        codemode: { mode, inlineBudget: mode === 'only' ? 0 : 3000 },
        retry: { enabled: false },
        compaction: { enabled: false },
      });

      const hooks = [];
      const loader = new DefaultResourceLoader({
        cwd: root,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        agentsFilesOverride: () => ({ agentsFiles: [] }),
        extensionFactories: [
          createCodemodeExtension({ models: false }),
          pi => {
            pi.registerTool({
              name: 'enable_fixture',
              label: 'Enable fixture',
              description: 'Enable the late fixture tool.\n\nCodemode: `tools.enable_fixture({})` resolves to a string.',
              parameters: Type.Object({}),
              defaultActive: false,
              async execute() {
                pi.setActiveTools([...pi.getActiveTools(), 'late_fixture']);
                return { content: [{ type: 'text', text: 'enabled' }], details: {} };
              },
            });
            pi.registerTool({
              name: 'late_fixture',
              label: 'Late fixture',
              description: 'Dynamically discovered late fixture.\n\nCodemode: `tools.late_fixture({})` resolves to a string.',
              parameters: Type.Object({}),
              defaultActive: false,
              async execute() {
                return { content: [{ type: 'text', text: 'LATE_TOOL_EXACT' }], details: {} };
              },
            });
            pi.on('session_start', () => pi.setActiveTools(['read', 'codemode', 'enable_fixture']));
            pi.on('tool_call', event => { hooks.push(event.toolName); });
          },
        ],
      });
      await loader.reload();

      const processes = [];
      const prompts = [];
      const cancellations = [];
      let bridgeCalls = 0;
      let rpcId = 0;

      runtime = new AcpRuntime({
        cwd: root,
        stateDirectory: path.join(root, 'acp-state'),
        sessionKey: `sdk-codemode-${mode}`,
        binary: 'offline-fake-agy',
        createProcess: async options => {
          const mcpConfig = JSON.parse(
            fs.readFileSync(path.join(options.geminiDir, 'config', 'mcp_config.json'), 'utf8'),
          );
          const entry = mcpConfig.mcpServers['acp-tools'];
          assert.equal(entry.timeoutSeconds, -1);

          const rpc = async (method, params = {}) => {
            const response = await fetch(entry.serverUrl, {
              method: 'POST',
              headers: { ...entry.headers, 'content-type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
            });
            assert.equal(response.status, 200);
            const body = await response.json();
            assert.equal(body.error, undefined);
            return body.result;
          };

          const controller = new AbortController();
          const fake = {
            options,
            signal: controller.signal,
            initialize: async () => {},
            getNativeHttpPort: async () => nativePort,
            newSession: async params => {
              assert.deepEqual(params.mcpServers, []);
              return {
                sessionId: 'native-codemode-session',
                configOptions: [{ id: 'model', currentValue: 'tool-flow', options: [{ value: 'tool-flow' }] }],
              };
            },
            loadSession: async () => ({ configOptions: [] }),
            setConfigOption: async () => ({
              configOptions: [{ id: 'model', currentValue: 'tool-flow', options: [{ value: 'tool-flow' }] }],
            }),
            prompt: async (sessionId, content) => {
              prompts.push({ sessionId, content });

              const agentPath = path.join(options.geminiDir, 'config', 'agents', options.agent, 'agent.md');
              const agentMd = fs.readFileSync(agentPath, 'utf8');
              assert.match(agentMd, /<identity>/);
              assert.doesNotMatch(agentMd, /running inside pi/i);
              assert.doesNotMatch(agentMd, /<guidelines>/);
              assert.match(agentMd, /<acp_tool_bridge>/);
              assert.match(agentMd, /<acp_active_tools>/);
              assert.match(agentMd, /No Node, file system, network, or timers/);
              assert.match(agentMd, /searchTools/);
              assert.match(agentMd, /优先通过 `call_mcp_tool` 调用 `codemode`/);
              if (mode === 'on') {
                assert.match(agentMd, /- read\(/);
                assert.match(agentMd, /Codemode: `tools\.read\(args\)`/);
              } else {
                assert.doesNotMatch(agentMd, /^- read\(/m);
              }

              const allowCodemode = await options.requestPermission({
                sessionId,
                toolCall: {
                  toolCallId: 'perm-cm-1',
                  name: 'call_mcp_tool',
                  kind: 'other',
                  rawInput: { ServerName: 'acp-tools', ToolName: 'codemode', Arguments: { code: '1' } },
                },
                options: [{ optionId: 'allow', kind: 'allow_always' }],
              });
              assert.equal(allowCodemode.outcome.optionId, 'allow');

              const firstList = (await rpc('tools/list')).tools;
              assert.equal(firstList.some(tool => tool.name === 'read'), mode === 'on');
              const coder = firstList.find(tool => tool.name === 'codemode');
              assert.ok(coder.description.includes('searchTools'));
              assert.ok(agentMd.includes(coder.description.trim()));

              bridgeCalls++;
              const readResult = await rpc('tools/call', {
                name: 'codemode',
                arguments: {
                  code: 'const r = await Promise.allSettled([tools.read({path:"a.txt"}),tools.read({path:"b.txt"})]); text(r); await tools.enable_fixture({});',
                },
              });
              assert.equal(readResult.isError, false);
              assert.match(JSON.stringify(readResult), /FIRST_READ_EXACT/);
              assert.match(JSON.stringify(readResult), /SECOND_READ_EXACT/);

              const nextList = (await rpc('tools/list')).tools;
              assert.equal(nextList.some(tool => tool.name === 'late_fixture'), mode === 'on');
              if (mode === 'on') {
                const lateSchema = JSON.parse(
                  fs.readFileSync(path.join(path.dirname(options.geminiDir), 'schemas', 'acp-tools', 'late_fixture.json'), 'utf8'),
                );
                assert.equal(lateSchema.targetName, 'late_fixture');
                const allowLate = await options.requestPermission({
                  sessionId,
                  toolCall: {
                    toolCallId: 'perm-late',
                    name: 'call_mcp_tool',
                    kind: 'other',
                    rawInput: { ServerName: 'acp-tools', ToolName: 'late_fixture', Arguments: {} },
                  },
                  options: [{ optionId: 'allow', kind: 'allow_always' }],
                });
                assert.equal(allowLate.outcome.optionId, 'allow');
              }

              bridgeCalls++;
              const lateResult = await rpc('tools/call', {
                name: 'codemode',
                arguments: {
                  code: 'text(await searchTools("late_fixture")); text(await tools.late_fixture({}));',
                },
              });
              assert.equal(lateResult.isError, false);
              assert.match(JSON.stringify(lateResult), /LATE_TOOL_EXACT/);

              options.onUpdate(
                {
                  sessionId,
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'CODEMODE_TASK_COMPLETE' },
                  },
                },
                { phase: 'prompt' },
              );
              return { stopReason: 'end_turn' };
            },
            cancel: async sessionId => {
              cancellations.push(sessionId);
              return { stopReason: 'cancelled' };
            },
            closeSession: async () => {},
            close: async () => { controller.abort(); },
          };
          processes.push(fake);
          return fake;
        },
      });

      const targetModel = modelRuntime.getModel(PROVIDER, 'tool-flow');
      ({ session } = await createAgentSession({
        cwd: root,
        agentDir,
        modelRuntime,
        model: targetModel,
        thinkingLevel: 'off',
        resourceLoader: loader,
        settingsManager,
        sessionManager: SessionManager.create(root, path.join(root, 'sessions')),
      }));
      await session.bindExtensions({});
      session.agent.streamFunction = (m, transcript, opts) => runtime.stream(m, transcript, opts);

      await session.prompt('Read the two fixtures and use the newly enabled tool in this same task.');

      const finalAssistant = session.agent.state.messages.findLast(m => m.role === 'assistant');
      assert.equal(finalAssistant?.stopReason, 'stop', `Assistant turn failed: ${finalAssistant?.errorMessage}`);
      assert.match(JSON.stringify(finalAssistant.content), /CODEMODE_TASK_COMPLETE/);

      assert.equal(processes.length, 1, 'must complete within a single ACP process');
      assert.equal(prompts.length, 1, 'must complete within a single native ACP prompt without mid-turn restart');
      assert.deepEqual(cancellations, [], 'must never cancel the live ACP turn on mid-turn tool activation');
      assert.equal(bridgeCalls, 2);
      assert.equal(hooks.filter(name => name === 'read').length, 2);
      assert.equal(hooks.filter(name => name === 'codemode').length, 2);
      assert.equal(hooks.filter(name => name === 'late_fixture').length, 1);

      // Cold-import verification: historical codemode calls must serialize as call_mcp_tool, never bare "codemode".
      const imported = buildNativeHistory(session.agent.state.messages, targetModel, {
        cwd: root,
        serverName: 'acp-tools',
      });
      const decoded = toJson(nativeTrajectorySchema, imported.trajectory);
      const plannerCalls = decoded.steps
        .filter(step => step.plannerResponse?.toolCalls?.length)
        .flatMap(step => step.plannerResponse.toolCalls);
      assert.equal(plannerCalls.length, 2);
      for (const call of plannerCalls) {
        assert.equal(call.name, 'call_mcp_tool');
        const parsed = JSON.parse(call.argumentsJson);
        assert.equal(parsed.ServerName, 'acp-tools');
        assert.equal(parsed.ToolName, 'codemode');
        assert.equal(typeof parsed.Arguments.code, 'string');
      }
    } finally {
      session?.dispose();
      await runtime?.close();
      await new Promise(resolve => nativeServer.close(resolve));
      if (previousMonitor === undefined) delete process.env.PI_AGY_NETWORK_MONITOR_CONFIG;
      else process.env.PI_AGY_NETWORK_MONITOR_CONFIG = previousMonitor;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
