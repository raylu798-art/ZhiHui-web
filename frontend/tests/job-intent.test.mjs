import assert from 'node:assert/strict';
import test from 'node:test';
import { JobIntent, PendingJobIntentError } from '../src/web/job-intent.mjs';

const summary = { kind: 'summary', meeting_id: 'meeting-1', template_id: 'general' };

test('unknown submission result reuses the original request ID and frozen payload on retry', () => {
  let count = 0;
  const intent = new JobIntent(() => `request-${++count}`);
  const original = intent.prepare(summary);
  // Transport failure does not confirm a job and therefore cannot clear the intent.
  assert.equal(intent.prepare({ template_id: 'general', meeting_id: 'meeting-1', kind: 'summary' }), original);
  assert.equal(count, 1);
  assert.ok(Object.isFrozen(original.payload));
  assert.equal(original.request_id, 'request-1');
});

test('changing a pending payload is blocked without consuming another request ID', () => {
  let count = 0;
  const intent = new JobIntent(() => `request-${++count}`);
  const original = intent.prepare(summary);
  assert.throws(() => intent.prepare({ ...summary, template_id: 'interview' }), PendingJobIntentError);
  assert.equal(intent.pending, original);
  assert.equal(count, 1);
  assert.throws(() => intent.prepare({ kind: 'transcribe', meeting_id: 'meeting-1', asset_id: 'audio', language: 'en' }), PendingJobIntentError);
});

test('a confirmed response permits a genuinely new intent even after completed or interrupted jobs', () => {
  let count = 0;
  const intent = new JobIntent(() => `request-${++count}`);
  const first = intent.prepare(summary);
  intent.confirmResponse({ id: 'job-1', kind: 'summary', meeting_id: 'meeting-1', state: 'completed' });
  const second = intent.prepare(summary);
  assert.notEqual(second.request_id, first.request_id);
  intent.confirmResponse({ id: 'job-2', kind: 'summary', meeting_id: 'meeting-1', state: 'interrupted' });
  assert.equal(intent.pending, undefined);
});

test('invalid responses retain the unknown intent, while an explicit reset starts a new one', () => {
  let count = 0;
  const intent = new JobIntent(() => `request-${++count}`);
  const original = intent.prepare(summary);
  assert.throws(() => intent.confirmResponse(null));
  assert.throws(() => intent.confirmResponse({ id: 'wrong-job', kind: 'transcribe', meeting_id: 'other' }));
  assert.equal(intent.pending, original);
  intent.resetForNewIntent();
  assert.equal(intent.prepare({ ...summary, template_id: 'interview' }).request_id, 'request-2');
});

test('file retries keep their initially selected language snapshot', () => {
  const intent = new JobIntent(() => 'request-file');
  intent.prepare({ kind: 'transcribe', meeting_id: 'meeting-1', asset_id: 'asset-1', language: 'zh' });
  const retry = intent.prepare(intent.pending.payload);
  assert.equal(retry.payload.language, 'zh');
  assert.throws(() => intent.prepare({ ...retry.payload, language: 'en' }), PendingJobIntentError);
});
