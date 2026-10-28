#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const manifest = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../server/Cargo.toml');
const tree = execFileSync('cargo', ['tree', '--manifest-path', manifest, '--locked',
  '--edges', 'normal,build', '--prefix', 'none', '--format', '{p}'], { encoding: 'utf8' });
const forbidden = /^(?:tauri(?:-[\w-]+)?|cpal|whisper-rs(?:-sys)?|sherpa-onnx(?:-sys)?|ort(?:-sys)?|silero|llama-helper|webkit2gtk(?:-sys)?|gtk(?:-sys)?)\s/;
const matches = [...new Set(tree.split(/\r?\n/).filter(line => forbidden.test(line)))];
if (matches.length) {
  console.error(`Web backend must not link desktop/native inference dependencies:\n${matches.join('\n')}`);
  process.exitCode = 1;
} else console.log('Web backend dependency isolation: passed (no desktop GUI, audio capture, or local inference engines).');
