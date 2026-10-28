import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageIdentity } from '../scripts/image-identity.mjs';

const webRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const parent = join(webRoot, '.test-data');
await mkdir(parent, { recursive: true });
const safeParent = await realpath(parent);
assert.ok(safeParent.startsWith(`${webRoot}${sep}`));
const scratch = await mkdtemp(join(safeParent, 'image-identity-'));
after(async () => {
  const target = await realpath(scratch);
  assert.equal(dirname(target), safeParent);
  assert.ok(target.startsWith(join(safeParent, 'image-identity-')));
  await rm(target, { recursive: true, force: true });
});

const image = 'zhihui-web:0.6.6-web.5';
const source = 'a'.repeat(64);
const release = '0.6.6-web.5';
const config = {
  os: 'linux', architecture: 'amd64', config: { Labels: {
    'org.opencontainers.image.revision': source,
    'org.opencontainers.image.version': release,
  } },
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const rawConfig = Buffer.from(`${JSON.stringify(config, null, 2)}\n`);

function header(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.fill(32, 148, 156);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  const checksum = h.reduce((sum, byte) => sum + byte, 0);
  h.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
function tar(entries) {
  const chunks = [];
  for (const { name, bytes = Buffer.alloc(0), type = '0' } of entries) {
    chunks.push(header(name, bytes.length, type), bytes,
      Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return Buffer.concat([...chunks, Buffer.alloc(1024)]);
}
function entries({ configPath = 'config.json', bytes = rawConfig, manifest } = {}) {
  return [
    { name: configPath, bytes },
    { name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest || [{ Config: configPath, RepoTags: [image], Layers: [] }])) },
  ];
}
async function run(bytes) {
  const path = join(scratch, `${randomUUID()}.tar`);
  await writeFile(path, bytes);
  return imageIdentity(path, image, source, release);
}

test('config identity hashes original bytes for classic and OCI Docker exports', async () => {
  const expected = `sha256:${hash(rawConfig)}`;
  assert.notEqual(expected, `sha256:${hash(Buffer.from(JSON.stringify(config)))}`);
  for (const configPath of ['config.json', `blobs/sha256/${hash(rawConfig)}`]) {
    const result = await run(tar([
      { name: 'blobs/', type: '5' },
      { name: 'layer.tar', bytes: Buffer.alloc(65536, 7) },
      ...entries({ configPath }),
    ]));
    assert.equal(result.imageConfigId, expected);
    assert.equal(result.os, 'linux');
    assert.equal(result.architecture, 'amd64');
  }
});

test('expected RepoTag must be present exactly once, including within one entry', async () => {
  for (const manifest of [
    [{ Config: 'config.json', RepoTags: ['other:test'] }],
    [{ Config: 'config.json', RepoTags: [image, image] }],
    [{ Config: 'config.json', RepoTags: [image] }, { Config: 'config.json', RepoTags: [image] }],
  ]) await assert.rejects(run(tar(entries({ manifest }))), /RepoTag/u);
});

test('unsafe Config references cannot escape or alias TAR paths', async () => {
  for (const configPath of ['../config.json', '/config.json', 'C:/config.json', 'a\\config.json', 'a//config.json', './config.json']) {
    const manifest = [{ Config: configPath, RepoTags: [image] }];
    await assert.rejects(run(tar(entries({ manifest }))), /Unsafe TAR/u);
  }
});

test('duplicate metadata names and linked metadata are rejected', async () => {
  for (const duplicate of ['manifest.json', 'config.json']) {
    const original = entries();
    const member = original.find(item => item.name === duplicate);
    await assert.rejects(run(tar([...original, member])), /Duplicate TAR/u);
  }
  for (const type of ['1', '2', 'x', 'g', 'L', 'K']) {
    await assert.rejects(run(tar([{ name: 'config.json', type }, entries()[1]])), /Unsupported TAR member type/u);
  }
  await assert.rejects(run(tar([{ name: 'config.json', type: '5' }, entries()[1]])), /regular TAR member/u);
});

test('platform and source/release labels are independently validated', async () => {
  for (const change of [
    { os: 'windows' }, { architecture: 'arm64' },
    { config: { Labels: { ...config.config.Labels, 'org.opencontainers.image.revision': 'b'.repeat(64) } } },
    { config: { Labels: { ...config.config.Labels, 'org.opencontainers.image.version': '0.6.6-web.4' } } },
  ]) await assert.rejects(run(tar(entries({ bytes: Buffer.from(JSON.stringify({ ...config, ...change })) }))), /platform|labels/u);
});

test('metadata allocation is bounded and invalid JSON/UTF-8 fails closed', async () => {
  for (const bytes of [Buffer.alloc(1024 * 1024 + 1, 32), Buffer.from('not-json'), Buffer.from([0xff])]) {
    await assert.rejects(run(tar(entries({ bytes }))), /JSON size|JSON|UTF-8/u);
  }
});

test('header corruption, truncation and hidden entries after end markers are rejected', async () => {
  const good = tar(entries());
  const corrupt = Buffer.from(good); corrupt[0] ^= 1;
  await assert.rejects(run(corrupt), /checksum/u);
  await assert.rejects(run(good.subarray(0, good.length - 1024)), /end marker/u);
  await assert.rejects(run(good.subarray(0, good.length - 1)), /length/u);
  await assert.rejects(run(Buffer.concat([good, tar(entries())])), /Nonzero data/u);
});
