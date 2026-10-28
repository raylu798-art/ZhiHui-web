import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../tests');
const files = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort().map(name => resolve(directory, name));
const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
