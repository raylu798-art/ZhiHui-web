#!/usr/bin/env node
// A real server + real SQLite + mocked billable provider. Local disposable data only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const binary = path.resolve(process.env.ZHIHUI_TEST_BINARY || path.join(root, 'server/target/debug', process.platform === 'win32' ? 'zhihui-web.exe' : 'zhihui-web'));
await fs.access(binary);
const runRoot = path.join(root, '.test-data', `smoke-${Date.now()}`);
await fs.mkdir(runRoot, { recursive: true });
const password = `Local-only-${randomBytes(16).toString('hex')}!`;
const keyA = `sk-smoke-asr-${randomBytes(10).toString('hex')}`;
const keySummary = `sk-smoke-summary-${randomBytes(10).toString('hex')}`;
let upstreamPaused = true;
let submissions = 0;
let providerDownloads = 0;
let summaryRequests = 0;
let upstreamFetchUrl;
let providerPort;
const upstream = new Map();
const summaryText = '# 会议纪要\n\n## 会议结论\n\n确认在周五发布知会 Web 演示。\n\n## 待办事项\n\n- 张三：完成验收。';
const mock = http.createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/api/v1/services/audio/asr/transcription' && request.method === 'POST') {
      assert.equal(request.headers.authorization, `Bearer ${keyA}`);
      const input = JSON.parse(body);
      assert.equal(input.model, 'paraformer-v2');
      assert.equal(input.parameters.diarization_enabled, true);
      upstreamFetchUrl = input.input.file_urls[0];
      const download = await fetch(upstreamFetchUrl, { headers: { Range: 'bytes=0-43' } });
      assert.equal(download.status, 206);
      assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 4).toString(), 'fLaC');
      providerDownloads++;
      const id = randomUUID(); upstream.set(id, {}); submissions++;
      response.end(JSON.stringify({ output: { task_id: id, task_status: 'PENDING' } })); return;
    }
    if (request.url.startsWith('/api/v1/tasks/')) {
      assert.equal(request.headers.authorization, `Bearer ${keyA}`);
      const id = request.url.split('/').pop(); assert.ok(upstream.has(id));
      response.end(JSON.stringify({ output: { task_id: id, task_status: upstreamPaused ? 'RUNNING' : 'SUCCEEDED',
        results: [{ subtask_status: 'SUCCEEDED', transcription_url: `http://127.0.0.1:${providerPort}/results/${id}.json` }] } })); return;
    }
    if (request.url.startsWith('/results/')) {
      response.end(JSON.stringify({ transcripts: [{ sentences: [
        { text: '确认在周五发布知会 Web 演示。', begin_time: 0, end_time: 500, speaker_id: 0 },
        { text: '张三负责完成验收。', begin_time: 500, end_time: 1000, speaker_id: 1 },
      ] }] })); return;
    }
    if (request.url === '/compatible-mode/v1/chat/completions') {
      assert.equal(request.headers.authorization, `Bearer ${keySummary}`);
      const input = JSON.parse(body);
      assert.equal(input.model, 'qwen-plus');
      assert.ok(input.messages.some(message => message.content.includes('张三')));
      summaryRequests++;
      response.end(JSON.stringify({ choices: [{ message: { content: summaryText } }] })); return;
    }
    response.statusCode = 404; response.end('{}');
  } catch (error) {
    response.statusCode = 500; response.end(JSON.stringify({ error: error.message }));
  }
});
await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
providerPort = mock.address().port;
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
const environment = { ...process.env, ZHIHUI_DATA_DIR: path.join(runRoot, 'data'),
  ZHIHUI_MASTER_KEY_FILE: path.join(runRoot, 'secrets/master_key'), ZHIHUI_PUBLIC_URL: base,
  ZHIHUI_BIND: `127.0.0.1:${port}`, ZHIHUI_STATIC_DIR: path.join(root, 'frontend/out'),
  ZHIHUI_DASHSCOPE_BASE: `http://127.0.0.1:${providerPort}`, ZHIHUI_POLL_SECONDS: '1',
  ZHIHUI_FFPROBE: process.env.ZHIHUI_FFPROBE || path.join(root, '.artifacts/tools/package/ffprobe.exe'),
  ZHIHUI_FFMPEG: process.env.ZHIHUI_FFMPEG || 'ffmpeg',
};
function cli(args, input) {
  const command = spawnSync(binary, args, { env: environment, input, encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(command.status, 0, `${args[0]} failed: ${command.stderr}`);
  return command.stdout;
}
let server;
async function start() {
  server = spawn(binary, ['serve'], { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  server.stdout.on('data', () => {}); server.stderr.on('data', () => {});
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Server exited: ${server.exitCode}`);
    try { const response = await fetch(`${base}/api/v1/health`); if (response.ok) return; } catch {}
    await pause(100);
  }
  throw new Error('Server startup timeout');
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  const done = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await Promise.race([done, pause(5000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await done; }
}
async function request(route, { method = 'GET', body, cookie, status = 200, origin = base, headers = {} } = {}) {
  const response = await fetch(`${base}/api/v1${route}`, { method, headers: {
    ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { Origin: origin } : {}),
    ...(body !== undefined && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
  const bytes = await response.arrayBuffer();
  const text = Buffer.from(bytes).toString();
  assert.equal(response.status, status, `${method} ${route}: ${response.status}: ${text.slice(0, 250)}`);
  return { data: (response.headers.get('content-type') || '').includes('application/json') ? JSON.parse(text) : text,
    response, bytes: Buffer.from(bytes), cookie: response.headers.get('set-cookie')?.split(';')[0] };
}
async function until(check, label) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await pause(100); }
  throw new Error(`Timeout: ${label}`);
}
function wav() {
  const buffer = Buffer.alloc(44 + 32000);
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24); buffer.writeUInt32LE(32000, 28); buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34); buffer.write('data', 36); buffer.writeUInt32LE(32000, 40);
  return buffer;
}
const passed = [];
try {
  cli(['init-key']); cli(['create-admin', '--username', 'smokeadmin'], `${password}\n`);
  await start();
  assert.equal((await request('/health')).data.version, '0.6.6');
  await request('/meetings', { status: 401 });
  await request('/auth/login', { method: 'POST', body: { username: 'smokeadmin', password }, origin: 'https://evil.invalid', status: 403 });
  const admin = await request('/auth/login', { method: 'POST', body: { username: 'smokeadmin', password } });
  assert.ok(admin.cookie.includes('zhihui_session='));
  assert.ok(admin.response.headers.get('set-cookie').includes('HttpOnly'));
  const invite = await request('/admin/invitations', { method: 'POST', cookie: admin.cookie });
  const alice = await request('/auth/accept-invite', { method: 'POST', body: { token: invite.data.token, username: 'smokealice', password } });
  await request('/auth/accept-invite', { method: 'POST', body: { token: invite.data.token, username: 'reusedinvite', password }, status: 400 });
  const secondInvite = await request('/admin/invitations', { method: 'POST', cookie: admin.cookie });
  const bob = await request('/auth/accept-invite', { method: 'POST', body: { token: secondInvite.data.token, username: 'smokebob', password } });
  await request('/admin/users', { cookie: alice.cookie, status: 403 });
  passed.push('invited accounts, single-use tokens, sessions, CSRF and admin permissions');

  const meeting = (await request('/meetings', { method: 'POST', cookie: alice.cookie, body: { title: 'Web 0.6.6 验收会议' } })).data;
  await request(`/meetings/${meeting.id}/import-text`, { method: 'POST', cookie: alice.cookie, body: { text: '原始讨论内容。\n第二段：张三负责验收。' } });
  assert.equal((await request('/meetings', { cookie: bob.cookie })).data.length, 0);
  await request(`/meetings/${meeting.id}`, { cookie: bob.cookie, status: 404 });
  await request(`/meetings/${meeting.id}`, { method: 'PATCH', cookie: bob.cookie, body: { title: 'unauthorized' }, status: 404 });
  await request(`/meetings/${meeting.id}`, { method: 'PATCH', cookie: alice.cookie, body: { title: '已重命名的验收会议' } });
  let detail = (await request(`/meetings/${meeting.id}`, { cookie: alice.cookie })).data;
  const transcript = detail.transcripts[0];
  await request(`/meetings/${meeting.id}/transcripts/${transcript.id}`, { method: 'PATCH', cookie: alice.cookie, body: { transcript: '编辑后的内容', speaker: 'S1' } });
  await request(`/meetings/${meeting.id}/speakers/rename`, { method: 'POST', cookie: alice.cookie, body: { from: 'S1', to: '主持人' } });
  await request(`/meetings/${meeting.id}/speakers/rename`, { method: 'POST', cookie: alice.cookie, body: { from: '', to: '参会人' } });
  detail = (await request(`/meetings/${meeting.id}`, { cookie: alice.cookie })).data;
  assert.ok(detail.transcripts.every(item => ['主持人', '参会人'].includes(item.speaker)));
  const template = (await request('/templates/custom-smoke', { method: 'PUT', cookie: alice.cookie, body: { name: '验收模板', description: '仅测试数据', prompt: '## 会议结论\n## 待办事项\n写清负责人。' } })).data;
  assert.ok(!(await request('/templates', { cookie: bob.cookie })).data.some(item => item.id === template.id));
  passed.push('meeting/transcript editing, speaker rename, custom templates and user isolation');

  const masked = (await request('/settings', { method: 'PUT', cookie: alice.cookie, body: { asr_key: keyA, summary_key: keySummary, summary_model: 'qwen-plus', asr_language: 'auto' } })).data;
  assert.equal(masked.asr.configured, true); assert.equal(masked.summary.configured, true);
  assert.ok(!JSON.stringify(masked).includes(keyA)); assert.ok(!JSON.stringify(masked).includes(keySummary));
  assert.equal((await request('/settings', { cookie: bob.cookie })).data.asr.configured, false);
  const form = new FormData(); form.append('file', new Blob([wav()], { type: 'audio/wav' }), '../../demo.wav');
  const asset = (await request('/assets', { method: 'POST', body: form, cookie: alice.cookie })).data;
  await request(`/assets/${asset.id}`, { cookie: bob.cookie, status: 404 });
  const partial = await request(`/assets/${asset.id}`, { cookie: alice.cookie, status: 206, headers: { Range: 'bytes=0-43' } });
  assert.equal(partial.bytes.length, 44); assert.equal(partial.response.headers.get('accept-ranges'), 'bytes');
  assert.equal(partial.bytes.subarray(0, 4).toString(), 'RIFF');
  await request(`/meetings/${meeting.id}/asset`, { method: 'POST', cookie: alice.cookie, body: { asset_id: asset.id } });
  const fileIntent = { request_id: randomUUID(), kind: 'transcribe', meeting_id: meeting.id, asset_id: asset.id };
  const job = (await request('/jobs', { method: 'POST', cookie: alice.cookie, body: fileIntent })).data;
  await request(`/jobs/${job.id}/cancel`, { method: 'POST', cookie: bob.cookie, status: 404 });
  await until(() => submissions === 1, 'initial provider submission');
  await pause(500); // Allow durable provider_id commit before simulating process loss.
  await stop(); await start();
  upstreamPaused = false;
  await until(async () => (await request('/jobs', { cookie: alice.cookie })).data.find(item => item.id === job.id)?.state === 'completed', 'resumed file job completion');
  assert.equal(submissions, 1); assert.equal(providerDownloads, 1);
  // Simulate a lost create response, followed by retry after the paid job completed.
  const repeatedFile = (await request('/jobs', { method: 'POST', cookie: alice.cookie, body: fileIntent })).data;
  assert.equal(repeatedFile.id, job.id); assert.equal(repeatedFile.state, 'completed');
  await request('/jobs', { method: 'POST', cookie: alice.cookie, body: { ...fileIntent, language: 'zh' }, status: 409 });
  await stop(); await start();
  assert.equal((await request('/jobs', { method: 'POST', cookie: alice.cookie, body: fileIntent })).data.id, job.id);
  assert.equal(submissions, 1);
  await request(upstreamFetchUrl.replace(`${base}/api/v1`, ''), { status: 404 });
  detail = (await request(`/meetings/${meeting.id}`, { cookie: alice.cookie })).data;
  assert.equal(detail.transcripts.length, 2); assert.ok(detail.transcripts[0].transcript.includes('周五'));
  passed.push('actual WAV upload/probe/Range, protected provider download, task restart and completed-response retry without duplicate billing');

  const summaryIntent = { request_id: randomUUID(), kind: 'summary', meeting_id: meeting.id, template_id: template.id };
  const summary = (await request('/jobs', { method: 'POST', cookie: alice.cookie, body: summaryIntent })).data;
  await until(async () => (await request('/jobs', { cookie: alice.cookie })).data.find(item => item.id === summary.id)?.state === 'completed', 'summary completion');
  assert.equal(summaryRequests, 1);
  assert.equal((await request('/jobs', { method: 'POST', cookie: alice.cookie, body: summaryIntent })).data.id, summary.id);
  await pause(300); assert.equal(summaryRequests, 1);
  detail = (await request(`/meetings/${meeting.id}`, { cookie: alice.cookie })).data;
  assert.equal(detail.summary, summaryText);
  await request(`/meetings/${meeting.id}/summary`, { method: 'PUT', cookie: alice.cookie, body: { markdown: `${summaryText}\n\n人工补充：验收完成。` } });
  assert.ok((await request(`/meetings/${meeting.id}`, { cookie: alice.cookie })).data.summary.includes('人工补充'));
  passed.push('template-driven cloud summary, persisted results and manual editing');

  cli(['backup', '--output', path.join(runRoot, 'backup')]);
  async function scan(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await scan(file);
      else {
        const bytes = await fs.readFile(file);
        assert.ok(!bytes.includes(Buffer.from(keyA)) && !bytes.includes(Buffer.from(keySummary)), `Plaintext test credential in ${entry.name}`);
      }
    }
  }
  await scan(path.join(runRoot, 'data')); await scan(path.join(runRoot, 'backup'));
  await request(`/admin/users/${bob.data.id}`, { method: 'PATCH', cookie: admin.cookie, body: { disabled: true } });
  await request('/auth/me', { cookie: bob.cookie, status: 401 });
  await request('/auth/logout', { method: 'POST', cookie: alice.cookie });
  await request('/auth/me', { cookie: alice.cookie, status: 401 });
  passed.push('verified online backup, encrypted credentials, account disabling and logout');

  await fs.writeFile(path.join(runRoot, 'browser-fixture.json'), JSON.stringify({ username: 'smokeadmin', password,
    dataDir: environment.ZHIHUI_DATA_DIR, masterKeyFile: environment.ZHIHUI_MASTER_KEY_FILE,
    meetingId: meeting.id, aliceUsername: 'smokealice', staticDir: environment.ZHIHUI_STATIC_DIR }, null, 2));
  const report = { ok: true, productVersion: '0.6.6', passed, providerSubmissions: submissions,
    summaryRequests, runRoot, externalProviderUsed: false };
  await fs.writeFile(path.join(runRoot, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await stop();
  await new Promise(resolve => mock.close(resolve));
}
