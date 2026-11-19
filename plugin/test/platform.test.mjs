import assert from 'node:assert/strict';
import {mkdtemp, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {resolveBinary} from '../src/platform.ts';

test('PATH agy is used even if a patched binary exists; explicit override wins', {skip: process.platform === 'win32'}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'agy-platform-test-'));
  const previous = {HOME: process.env.HOME, PATH: process.env.PATH, AGY_BINARY: process.env.AGY_BINARY};
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(dir, {recursive: true, force: true});
  });
  const bin = join(dir, '.gemini', 'bin');
  await mkdir(bin, {recursive: true});
  const regular = join(bin, 'agy'), patched = join(bin, 'agy-512k');
  await writeFile(regular, '', {mode: 0o755});
  await writeFile(patched, '', {mode: 0o755});
  process.env.HOME = dir;
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  delete process.env.AGY_BINARY;
  assert.equal(resolveBinary(), await realpath(regular));
  process.env.AGY_BINARY = patched;
  assert.equal(resolveBinary(), await realpath(patched));
});
