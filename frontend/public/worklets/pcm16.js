/* Browser-only audio transport. Continuous mono PCM16 at 16 kHz. */
class Pcm16Processor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.remaining = this.ratio;
    this.total = 0;
    this.samples = new Int16Array(1024);
    this.offset = 0;
    this.frames = 0;
    this.port.onmessage = event => {
      if (event.data === 'flush') { this.flush(); this.port.postMessage({ type: 'flushed' }); }
    };
  }
  flush() {
    if (!this.offset) return;
    const buffer = new ArrayBuffer(this.offset * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < this.offset; i++) view.setInt16(i * 2, this.samples[i], true);
    this.port.postMessage({ type: 'pcm', buffer }, [buffer]);
    this.offset = 0;
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length) return true;
    const count = channels[0].length;
    let energy = 0;
    for (let i = 0; i < count; i++) {
      let mono = 0;
      for (const channel of channels) mono += channel[i] / channels.length;
      energy += mono * mono;
      let available = 1;
      while (available > 0.000001) {
        const take = Math.min(available, this.remaining);
        this.total += mono * take;
        available -= take;
        this.remaining -= take;
        if (this.remaining < 0.000001) {
          const value = Math.max(-1, Math.min(1, this.total / this.ratio));
          this.samples[this.offset++] = value < 0 ? value * 32768 : value * 32767;
          this.remaining = this.ratio;
          this.total = 0;
          if (this.offset === this.samples.length) this.flush();
        }
      }
    }
    if (++this.frames % 12 === 0) this.port.postMessage({ type: 'level', value: Math.min(1, Math.sqrt(energy / count) * 5) });
    return true;
  }
}
registerProcessor('zhihui-pcm16', Pcm16Processor);
