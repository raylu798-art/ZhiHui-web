import { copyFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(resolve(root, 'public/workers'), { recursive: true });
await copyFile(require.resolve('pdfjs-dist/build/pdf.worker.min.mjs'), resolve(root, 'public/workers/pdf.worker.min.mjs'));
