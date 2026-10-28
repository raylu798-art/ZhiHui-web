import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const BLOCK = 512;
const MAX_JSON = 1024 * 1024;
const fail = message => { throw new Error(message); };
const zeros = bytes => bytes.every(byte => byte === 0);

function field(bytes) {
  const end = bytes.indexOf(0);
  if (end >= 0 && !zeros(bytes.subarray(end))) fail('Nonzero TAR string padding');
  const raw = end < 0 ? bytes : bytes.subarray(0, end);
  const value = raw.toString('utf8');
  if (!Buffer.from(value, 'utf8').equals(raw)) fail('Invalid TAR UTF-8');
  return value;
}

function safePath(name) {
  if (!name || name.startsWith('/') || /[\\:\x00-\x1f\x7f]/u.test(name)
    || name.split('/').some(part => !part || part === '.' || part === '..')) {
    fail('Unsafe TAR member path');
  }
  return name;
}

function octal(bytes) {
  const value = bytes.toString('ascii').replace(/[\0 ]+$/u, '').replace(/^ +/u, '');
  if (!/^[0-7]+$/u.test(value)) fail('Unsupported TAR number');
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number) || number < 0) fail('Invalid TAR number');
  return number;
}

async function exact(file, length, position) {
  const bytes = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const result = await file.read(bytes, done, length - done, position + done);
    if (!result.bytesRead) fail('Truncated TAR archive');
    done += result.bytesRead;
  }
  return bytes;
}

async function indexTar(file, length) {
  if (!Number.isSafeInteger(length) || length < 2 * BLOCK || length % BLOCK) fail('Invalid TAR length');
  const members = new Map();
  let position = 0;
  while (position + BLOCK <= length) {
    const header = await exact(file, BLOCK, position);
    if (zeros(header)) {
      if (position + 2 * BLOCK > length || !zeros(await exact(file, BLOCK, position + BLOCK))) fail('Missing TAR end marker');
      // Bound memory even for unusually long padding, and reject hidden trailing entries.
      for (let offset = position + 2 * BLOCK; offset < length; offset += 65536) {
        if (!zeros(await exact(file, Math.min(65536, length - offset), offset))) fail('Nonzero data after TAR end marker');
      }
      return members;
    }
    if (members.size >= 100000) fail('Too many TAR members');
    const expected = octal(header.subarray(148, 156));
    let checksum = 0;
    for (let i = 0; i < BLOCK; i++) checksum += i >= 148 && i < 156 ? 32 : header[i];
    if (checksum !== expected) fail('Invalid TAR header checksum');
    const magic = header.subarray(257, 263);
    if (!zeros(magic) && !magic.equals(Buffer.from('ustar\0'))) fail('Unsupported TAR header format');
    const prefix = zeros(magic) ? '' : field(header.subarray(345, 500));
    const leaf = field(header.subarray(0, 100));
    const type = header[156];
    // Docker save uses regular files/directories. Reject links and PAX/GNU overrides.
    if (![0, 48, 53].includes(type)) fail('Unsupported TAR member type');
    const rawName = prefix ? `${prefix}/${leaf}` : leaf;
    const name = safePath(type === 53 ? rawName.replace(/\/$/u, '') : rawName);
    if (members.has(name)) fail('Duplicate TAR member path');
    const size = octal(header.subarray(124, 136));
    if (type === 53 && size) fail('Directory TAR member has content');
    const dataPosition = position + BLOCK;
    const next = dataPosition + Math.ceil(size / BLOCK) * BLOCK;
    if (!Number.isSafeInteger(next) || next > length) fail('TAR member exceeds archive');
    members.set(name, { position: dataPosition, size, regular: type !== 53 });
    position = next;
  }
  fail('Missing TAR end marker');
}

async function jsonMember(file, members, name) {
  const entry = members.get(safePath(name));
  if (!entry?.regular) fail('Required image metadata must be a regular TAR member');
  if (!entry.size || entry.size > MAX_JSON) fail('Image metadata exceeds bounded JSON size');
  const bytes = await exact(file, entry.size, entry.position);
  if (!Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) fail('Invalid image metadata UTF-8');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('Invalid image metadata JSON'); }
  return { bytes, value };
}

/** Hash the original exported config bytes, independently of Docker's image-store ID. */
export async function imageIdentity(archive, expectedImage, sourceSha, releaseId) {
  if (!/^[a-z0-9][a-z0-9._:/-]{0,254}$/u.test(expectedImage)
    || !/^[0-9a-f]{64}$/u.test(sourceSha) || !/^\d+\.\d+\.\d+-web\.\d+$/u.test(releaseId)) fail('Invalid expected image identity');
  const file = await open(archive, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) fail('Image archive must be a regular file');
    const members = await indexTar(file, stat.size);
    const { value: manifest } = await jsonMember(file, members, 'manifest.json');
    if (!Array.isArray(manifest) || !manifest.length || manifest.length > 1024) fail('Invalid Docker save manifest');
    const matches = [];
    for (const entry of manifest) {
      if (!entry || typeof entry !== 'object' || !Array.isArray(entry.RepoTags)) continue;
      for (const tag of entry.RepoTags) if (tag === expectedImage) matches.push(entry);
    }
    if (matches.length !== 1 || typeof matches[0].Config !== 'string') fail('Expected RepoTag must occur exactly once');
    const { bytes, value: config } = await jsonMember(file, members, matches[0].Config);
    const labels = config?.config?.Labels;
    if (config?.os !== 'linux' || config?.architecture !== 'amd64') fail('Image platform must be linux/amd64');
    if (labels?.['org.opencontainers.image.revision'] !== sourceSha
      || labels?.['org.opencontainers.image.version'] !== releaseId) fail('Image labels differ from expected source/release');
    return { imageConfigId: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, os: 'linux', architecture: 'amd64' };
  } finally { await file.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 6) fail('Usage: image-identity.mjs ARCHIVE IMAGE SOURCE_SHA RELEASE_ID');
    console.log(JSON.stringify(await imageIdentity(...process.argv.slice(2))));
  } catch (error) {
    console.error(`Image identity validation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
