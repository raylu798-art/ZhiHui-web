import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/worklets/pcm16.js', import.meta.url), 'utf8');
function processor(rate) {
  let Processor;
  const sent = [];
  class Worklet { port = { postMessage(message) { sent.push(message); } }; }
  const context = vm.createContext({ AudioWorkletProcessor: Worklet, sampleRate: rate, registerProcessor(name, type) { assert.equal(name, 'zhihui-pcm16'); Processor = type; } });
  vm.runInContext(source, context);
  return { value: new Processor(), sent };
}
for (const rate of [16000, 44100, 48000]) {
  test(`${rate} Hz input produces continuous little-endian 16 kHz PCM16`, () => {
    const { value, sent } = processor(rate);
    for (let frame = 0; frame < rate; frame += 128) {
      const samples = new Float32Array(Math.min(128, rate - frame)); samples.fill(0.5);
      value.process([[samples]]);
    }
    value.port.onmessage({ data: 'flush' });
    const chunks = sent.filter(message => message.type === 'pcm');
    const total = chunks.reduce((count, message) => count + message.buffer.byteLength / 2, 0);
    assert.equal(total, 16000);
    for (const chunk of chunks) {
      assert.ok(chunk.buffer.byteLength <= 2048);
      const bytes = new DataView(chunk.buffer);
      for (let index = 0; index < bytes.byteLength; index += 2) assert.equal(bytes.getInt16(index, true), 16383);
    }
    assert.equal(sent.at(-1).type, 'flushed');
  });
}
test('stereo downmix clips both polarities safely and reports normalized levels', () => {
  const { value, sent } = processor(16000);
  const samples = new Float32Array(128).fill(2);
  for (let i = 0; i < 12; i++) value.process([[samples, samples]]);
  value.port.onmessage({ data: 'flush' });
  assert.equal(new DataView(sent.find(message => message.type === 'pcm').buffer).getInt16(0, true), 32767);
  assert.ok(sent.some(message => message.type === 'level' && message.value === 1));
  const negative = processor(16000); negative.value.process([[new Float32Array(128).fill(-2)]]); negative.value.port.onmessage({ data: 'flush' });
  assert.equal(new DataView(negative.sent.find(message => message.type === 'pcm').buffer).getInt16(0, true), -32768);
});
