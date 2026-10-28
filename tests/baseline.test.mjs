import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hash, inside, verify, review, stageSync, accept } from '../scripts/baseline.mjs';

async function fixture(t) {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'zhihui-web-baseline-'));
  t.after(() => fs.rm(repo, { recursive: true, force: true }));
  const web = path.join(repo, 'web');
  const desktop = path.join(repo, 'ZhiHui/frontend');
  await fs.mkdir(path.join(desktop, 'src'), { recursive: true });
  await fs.mkdir(path.join(web, 'frontend/src'), { recursive: true });
  const original = 'export const title = "知会";\n';
  const packageJson = '{"name":"zhihui","version":"0.6.6"}\n';
  await fs.writeFile(path.join(desktop, 'src/view.ts'), original);
  await fs.writeFile(path.join(web, 'frontend/src/view.ts'), original);
  await fs.writeFile(path.join(desktop, 'package.json'), packageJson);
  await fs.writeFile(path.join(web, 'frontend/package.json'), packageJson);
  await fs.writeFile(path.join(web, 'baseline.json'), JSON.stringify({ productVersion: '0.6.6', webBuild: 1,
    desktopFiles: { 'ZhiHui/frontend/src/view.ts': hash(original), 'ZhiHui/frontend/package.json': hash(packageJson) },
    sources: { 'frontend/src/view.ts': { source: 'ZhiHui/frontend/src/view.ts', sha256: hash(original) },
      'frontend/package.json': { source: 'ZhiHui/frontend/package.json', sha256: hash(packageJson) } } }));
  return { repo, web, desktop, original };
}

test('version and fingerprint gate accepts the untouched baseline', async t => {
  const { web } = await fixture(t);
  const result = await verify(web);
  assert.equal(result.productVersion, '0.6.6');
  assert.equal(result.desktopFiles, 2);
});

test('Web overrides require reviewed hashes and subsequent edits invalidate review', async t => {
  const { web, desktop, original } = await fixture(t);
  const file = path.join(web, 'frontend/src/view.ts');
  await fs.writeFile(file, `${original}// Web adapter\n`);
  await assert.rejects(verify(web), /Unreviewed Web overrides/);
  assert.equal((await review(web)).reviewedOverrides, 1);
  assert.equal((await verify(web)).ok, true);
  await fs.appendFile(file, '// changed after review\n');
  await assert.rejects(verify(web), /Unreviewed/);
  assert.equal(await fs.readFile(path.join(desktop, 'src/view.ts'), 'utf8'), original);
});

test('desktop source changes cannot be hidden by re-reviewing Web', async t => {
  const { web, desktop } = await fixture(t);
  await fs.appendFile(path.join(desktop, 'src/view.ts'), '// next desktop release\n');
  await assert.rejects(verify(web), /Desktop baseline changed/);
  await assert.rejects(review(web), /Desktop baseline changed/);
});

test('staging never overwrites adapted files or desktop; accept requires resolved merge', async t => {
  const { web, desktop, original } = await fixture(t);
  const webFile = path.join(web, 'frontend/src/view.ts');
  const desktopFile = path.join(desktop, 'src/view.ts');
  await fs.writeFile(webFile, `${original}// adapter\n`);
  await review(web);
  const nextDesktop = `${original}// upstream fix\n`;
  await fs.writeFile(desktopFile, nextDesktop);
  const staged = await stageSync(web);
  assert.equal(staged.conflicts, 1);
  assert.equal(await fs.readFile(webFile, 'utf8'), `${original}// adapter\n`);
  await assert.rejects(accept(web), /still requires merge/);
  await fs.writeFile(webFile, `${nextDesktop}// reviewed adapter\n`);
  await accept(web);
  await review(web);
  assert.equal((await verify(web)).ok, true);
  assert.equal(await fs.readFile(desktopFile, 'utf8'), nextDesktop);
});

test('new upstream UI files block verification until explicitly staged and copied', async t => {
  const { web, desktop } = await fixture(t);
  await fs.writeFile(path.join(desktop, 'src/new.ts'), '// added\n');
  await assert.rejects(verify(web), /new.ts \(new\)/);
  assert.equal((await stageSync(web)).newDesktopFiles, 1);
  await assert.rejects(accept(web), /copy new upstream/);
  await fs.copyFile(path.join(desktop, 'src/new.ts'), path.join(web, 'frontend/src/new.ts'));
  await accept(web);
  assert.equal((await verify(web)).ok, true);
});

test('path traversal and symlink output escapes are rejected', async t => {
  assert.throws(() => inside('/repo/web', '../desktop'), /Unsafe|escapes/);
  assert.throws(() => inside('/repo/web', 'frontend/../server'), /Unsafe/);
  assert.throws(() => inside('/repo/web', '/etc/passwd'), /Unsafe/);
  assert.throws(() => inside('/repo/web', 'frontend\\..\\..\\desktop'), /Unsafe/);
  const { web, repo } = await fixture(t);
  const outside = path.join(repo, 'outside');
  await fs.mkdir(outside);
  try { await fs.symlink(outside, path.join(web, '.artifacts'), 'junction'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('Windows symlink privilege unavailable'); throw error; }
  await assert.rejects(stageSync(web), /Symlinks are not allowed/);
});

test('a Web version mismatch blocks publishing', async t => {
  const { web } = await fixture(t);
  await fs.writeFile(path.join(web, 'frontend/package.json'), '{"version":"0.7.0"}');
  await review(web);
  await assert.rejects(verify(web), /product versions differ/);
});
