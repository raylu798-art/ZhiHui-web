#!/usr/bin/env node
// The desktop is a read-only input. Every output is constrained to web/.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(webRoot, '..');
const SOURCE_DIRS = ['ZhiHui/frontend/src', 'ZhiHui/frontend/public',
  'ZhiHui/frontend/src-tauri/src', 'ZhiHui/frontend/src-tauri/templates',
  'ZhiHui/frontend/src-tauri/migrations'];
const normalize = value => value.split(path.sep).join('/');
export const hash = data => createHash('sha256').update(data).digest('hex');

export function inside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || path.isAbsolute(relative)
    || relative.split('/').some(segment => segment === '..' || segment === '.' || !segment))
    throw new Error(`Unsafe relative path: ${relative}`);
  const full = path.resolve(root, relative);
  const rel = path.relative(root, full);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
    throw new Error(`Path escapes its root: ${relative}`);
  return full;
}

async function noSymlinks(root, target) {
  let current = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${current}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

export async function fileHash(file) {
  try { return hash(await fs.readFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function walk(root, relative) {
  const result = [];
  const directory = inside(root, relative);
  let entries;
  try { entries = await fs.readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Unexpected source symlink: ${relative}/${entry.name}`);
    const child = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await walk(root, child));
    else if (entry.isFile()) result.push(child);
  }
  return result;
}

export async function loadBaseline(root = webRoot) {
  const baseline = JSON.parse(await fs.readFile(path.join(root, 'baseline.json'), 'utf8'));
  if (!baseline.productVersion || !baseline.desktopFiles || !baseline.sources)
    throw new Error('Invalid baseline manifest');
  for (const [relative, digest] of Object.entries(baseline.desktopFiles)) {
    if (!relative.startsWith('ZhiHui/') || !/^[a-f0-9]{64}$/.test(digest))
      throw new Error(`Invalid desktop fingerprint: ${relative}`);
    inside(path.resolve(root, '..'), relative);
  }
  for (const [relative, source] of Object.entries(baseline.sources)) {
    const frontend = relative.startsWith('frontend/') && source.source.startsWith('ZhiHui/frontend/');
    const server = relative.startsWith('server/') && source.source.startsWith('ZhiHui/frontend/src-tauri/');
    if (!frontend && !server)
      throw new Error(`Invalid snapshot mapping: ${relative}`);
    inside(root, relative);
    inside(path.resolve(root, '..'), source.source);
    if (baseline.desktopFiles[source.source] !== source.sha256)
      throw new Error(`Snapshot fingerprint differs from desktop baseline: ${relative}`);
  }
  return baseline;
}

export async function desktopDifferences(root, baseline) {
  const repository = path.resolve(root, '..');
  const differences = [];
  for (const [relative, digest] of Object.entries(baseline.desktopFiles)) {
    const source = inside(repository, relative);
    await noSymlinks(repository, source);
    if (await fileHash(source) !== digest) differences.push(relative);
  }
  for (const directory of SOURCE_DIRS) {
    for (const relative of await walk(repository, directory)) {
      if (!Object.hasOwn(baseline.desktopFiles, relative)) differences.push(`${relative} (new)`);
    }
  }
  return [...new Set(differences)];
}

async function assertDesktop(root, baseline) {
  const differences = await desktopDifferences(root, baseline);
  if (differences.length) throw new Error(`Desktop baseline changed; review/synchronize before publishing:\n${differences.join('\n')}`);
}

async function readReviews(root) {
  try { return JSON.parse(await fs.readFile(path.join(root, 'overrides.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}

export async function review(root = webRoot) {
  const baseline = await loadBaseline(root);
  await assertDesktop(root, baseline);
  const overrides = {};
  for (const [relative, source] of Object.entries(baseline.sources)) {
    const target = inside(root, relative);
    await noSymlinks(root, target);
    const digest = await fileHash(target);
    if (digest !== source.sha256) overrides[relative] = { sourceHash: source.sha256, webHash: digest };
  }
  const output = inside(root, 'overrides.json');
  await noSymlinks(root, output);
  await fs.writeFile(output, `${JSON.stringify(overrides, null, 2)}\n`);
  return { reviewedOverrides: Object.keys(overrides).length };
}

export async function verify(root = webRoot, { overrides = true } = {}) {
  const baseline = await loadBaseline(root);
  await assertDesktop(root, baseline);
  const reviews = await readReviews(root);
  const unreviewed = [];
  for (const [relative, source] of Object.entries(baseline.sources)) {
    const target = inside(root, relative);
    await noSymlinks(root, target);
    const digest = await fileHash(target);
    if (digest !== source.sha256 && overrides) {
      const reviewed = reviews[relative];
      if (!reviewed || reviewed.sourceHash !== source.sha256 || reviewed.webHash !== digest)
        unreviewed.push(relative);
    }
  }
  if (unreviewed.length) throw new Error(`Unreviewed Web overrides (review the diff, then run baseline.mjs review):\n${unreviewed.join('\n')}`);
  const packageJson = JSON.parse(await fs.readFile(path.join(root, 'frontend/package.json'), 'utf8'));
  if (packageJson.version !== baseline.productVersion) throw new Error('Web and desktop product versions differ');
  const serverCargo = await fs.readFile(path.join(root, 'server/Cargo.toml'), 'utf8').catch(error => {
    if (error.code === 'ENOENT' && !Object.keys(baseline.sources).some(key => key.startsWith('server/'))) return '';
    throw error;
  });
  if (serverCargo) {
    const serverVersion = serverCargo.match(/\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m)?.[1];
    if (serverVersion !== baseline.productVersion) throw new Error('Web server and desktop product versions differ');
  }
  const sourceFingerprint = hash(JSON.stringify(Object.entries(baseline.desktopFiles).sort()));
  return { ok: true, productVersion: baseline.productVersion, webBuild: baseline.webBuild,
    desktopFiles: Object.keys(baseline.desktopFiles).length,
    snapshotFiles: Object.keys(baseline.sources).length, sourceFingerprint,
    reviewedOverrides: Object.keys(reviews).length };
}

// Stage changed upstream inputs for a human/agent merge, never overwrite adapted files.
export async function stageSync(root = webRoot) {
  const baseline = await loadBaseline(root);
  const repository = path.resolve(root, '..');
  const incomingRoot = inside(root, '.artifacts/incoming');
  await noSymlinks(root, incomingRoot);
  const changes = [];
  const desktopChanges = [];
  for (const [relative, oldHash] of Object.entries(baseline.desktopFiles)) {
    const source = inside(repository, relative);
    await noSymlinks(repository, source);
    const newHash = await fileHash(source);
    if (newHash !== oldHash) desktopChanges.push({ source: relative, oldHash, newHash });
  }
  for (const [relative, source] of Object.entries(baseline.sources)) {
    const sourceFile = inside(repository, source.source);
    await noSymlinks(repository, sourceFile);
    const newHash = await fileHash(sourceFile);
    if (newHash === source.sha256) continue;
    const target = inside(root, relative);
    await noSymlinks(root, target);
    const webHash = await fileHash(target);
    const change = { target: relative, source: source.source, oldHash: source.sha256, newHash,
      webHash, requiresMerge: webHash !== source.sha256, deleted: newHash === null };
    changes.push(change);
    if (newHash) {
      const staged = inside(root, `.artifacts/incoming/${relative}`);
      await noSymlinks(root, staged);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.copyFile(sourceFile, staged);
    }
  }
  const additions = [];
  for (const directory of SOURCE_DIRS) {
    for (const relative of await walk(repository, directory)) {
      if (!Object.hasOwn(baseline.desktopFiles, relative)) additions.push(relative);
    }
  }
  await fs.mkdir(incomingRoot, { recursive: true });
  const report = inside(root, '.artifacts/incoming/changes.json');
  await noSymlinks(root, report);
  await fs.writeFile(report, `${JSON.stringify({ changes, desktopChanges, additions }, null, 2)}\n`);
  return { staged: changes.length, newDesktopFiles: additions.length,
    conflicts: changes.filter(change => change.requiresMerge).length,
    instructions: 'Merge the staged inputs in web/.artifacts/incoming. Desktop inputs and Web overrides were not changed.' };
}

// Explicit baseline advancement AFTER staged changes have been reviewed and merged.
export async function accept(root = webRoot) {
  const old = await loadBaseline(root);
  const repository = path.resolve(root, '..');
  const staged = JSON.parse(await fs.readFile(path.join(root, '.artifacts/incoming/changes.json'), 'utf8'));
  const currentDifferences = await desktopDifferences(root, old);
  const known = new Set([...staged.desktopChanges.map(item => item.source), ...staged.additions]);
  const unexpected = currentDifferences.filter(item => !known.has(item.replace(/ \(new\)$/, '')));
  if (unexpected.length) throw new Error(`Desktop changed outside staged sync:\n${unexpected.join('\n')}`);
  for (const change of staged.desktopChanges) {
    if (await fileHash(inside(repository, change.source)) !== change.newHash)
      throw new Error(`Desktop changed since staging: ${change.source}`);
  }
  for (const change of staged.changes) {
    if (await fileHash(inside(repository, change.source)) !== change.newHash)
      throw new Error(`Source changed since staging: ${change.source}`);
    if (change.requiresMerge && await fileHash(inside(root, change.target)) === change.webHash)
      throw new Error(`Adapted file still requires merge/review: ${change.target}`);
    if (!change.requiresMerge && await fileHash(inside(root, change.target)) !== change.newHash)
      throw new Error(`Copy reviewed upstream input into Web first: ${change.target}`);
  }
  for (const relative of Object.keys(old.desktopFiles)) {
    const digest = await fileHash(inside(repository, relative));
    if (digest) old.desktopFiles[relative] = digest;
    else delete old.desktopFiles[relative];
  }
  for (const relative of staged.additions) {
    old.desktopFiles[relative] = await fileHash(inside(repository, relative));
    if (relative.startsWith('ZhiHui/frontend/src/') || relative.startsWith('ZhiHui/frontend/public/')) {
      const target = relative.replace('ZhiHui/frontend/', 'frontend/');
      if (!await fileHash(inside(root, target))) throw new Error(`Review and copy new upstream file first: ${target}`);
      old.sources[target] = { source: relative, sha256: old.desktopFiles[relative] };
    }
  }
  for (const [relative, source] of Object.entries(old.sources)) {
    if (old.desktopFiles[source.source]) source.sha256 = old.desktopFiles[source.source];
    else delete old.sources[relative];
  }
  const desktopPackage = JSON.parse(await fs.readFile(path.join(repository, 'ZhiHui/frontend/package.json'), 'utf8'));
  old.productVersion = desktopPackage.version;
  const destination = inside(root, 'baseline.json');
  await noSymlinks(root, destination);
  await fs.writeFile(destination, `${JSON.stringify(old, null, 2)}\n`);
  return { productVersion: old.productVersion, instructions: 'Align Web version, validate behavior, then baseline.mjs review and verify.' };
}

async function main() {
  const command = process.argv[2] || 'verify';
  const commands = { verify, review, stage: stageSync, accept };
  if (!commands[command]) throw new Error('Usage: node web/scripts/baseline.mjs [verify|review|stage|accept]');
  console.log(JSON.stringify(await commands[command](), null, 2));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
