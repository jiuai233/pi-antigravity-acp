// Load the real extension in a private SDK session. Never call prompt or launch AGY.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const kit = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(kit, 'plugin');
const sdkRoot = path.join(plugin, 'node_modules/@earendil-works/pi-coding-agent');
const sdk = await import(pathToFileURL(path.join(sdkRoot, 'dist/index.js')).href);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-acp-kit-smoke-'));
const env = { ...process.env };
let session;
try {
  const agentDir = path.join(temp, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.AGY_ACP_STATE_DIR = path.join(temp, 'native-state');
  process.env.PI_AGY_NETWORK_MONITOR_CONFIG = path.join(temp, 'absent-monitor.json');
  process.env.AGY_BINARY = path.join(temp, 'must-not-launch-agy.exe');
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], extensions: [], skills: [],
    retry: { enabled: false }, compaction: { enabled: false }, codemode: { mode: 'off' } });
  const modelRuntime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'),
    modelsPath: null, refreshOnCreate: false });
  const loader = new sdk.DefaultResourceLoader({ cwd: temp, agentDir, settingsManager,
    additionalExtensionPaths: [path.join(plugin, 'index.ts')], noSkills: true,
    noPromptTemplates: true, noThemes: true, noContextFiles: true,
    disabledBuiltinExtensions: ['mcp', 'codemode'], systemPrompt: 'Offline SDK loading check.' });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.deepEqual(loaded.errors, []);
  ({ session } = await sdk.createAgentSession({ cwd: temp, agentDir, modelRuntime,
    settingsManager, sessionManager: sdk.SessionManager.inMemory(temp), resourceLoader: loader,
    noTools: 'all' }));
  const models = modelRuntime.getModels('antigravity-acp');
  const commands = loaded.extensions.flatMap(extension => [...extension.commands.keys()]);
  assert.ok(models.length > 0, 'ACP provider models registered');
  assert.ok(commands.includes('agy-acp'), 'ACP command registered');
  assert.equal(fs.existsSync(path.join(temp, 'native-state')), false, 'No native state or AGY launch');
  console.log(JSON.stringify({ ok: true, provider: 'antigravity-acp', models: models.length,
    commands, extensionErrors: loaded.errors, prompts: 0, nativeStateCreated: false }));
} finally {
  session?.dispose();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
