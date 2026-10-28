import { api, messageOf, Transcript } from './api';

interface RecorderOptions {
  title: string; language: string; includeSystem: boolean;
  onCreated: (meetingId: string) => void;
  onTranscript: (transcript: Transcript) => void;
  onError: (message: string) => void;
  onClosed: () => void;
  onLevel: (level: number) => void;
}

/** Never reconnect automatically: reconnecting would create another billable session. */
export class BrowserRecorder {
  private streams: MediaStream[] = [];
  private context?: AudioContext;
  private processor?: AudioWorkletNode;
  private socket?: WebSocket;
  private stopping = false;
  private closed = false;
  private flushed?: () => void;
  private constructor(private options: RecorderOptions) {}

  static async start(options: RecorderOptions): Promise<BrowserRecorder> {
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('录音需要 HTTPS 或 localhost，并且浏览器必须支持麦克风访问');
    const recorder = new BrowserRecorder(options);
    try { await recorder.open(); return recorder; }
    catch (error) { await recorder.dispose(); throw error; }
  }

  private async open() {
    const microphone = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    this.streams.push(microphone);
    if (this.options.includeSystem) {
      if (!navigator.mediaDevices.getDisplayMedia) throw new Error('当前浏览器不支持共享声音');
      const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      this.streams.push(display);
      if (!display.getAudioTracks().length) throw new Error('未获得共享声音，请在选择共享内容时勾选“共享音频”');
    }
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.audioWorklet.addModule('/worklets/pcm16.js');
    await this.context.resume();
    const recording = await api<{ id: string; meeting_id: string; websocket_path: string }>('/recordings', 'POST', { title: this.options.title, language: this.options.language });
    this.options.onCreated(recording.meeting_id);
    const socketUrl = new URL(recording.websocket_path, window.location.origin);
    if (socketUrl.origin !== window.location.origin) throw new Error('录音服务返回了无效的连接地址');
    socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(socketUrl);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('实时转写连接超时')), 15000);
      socket.onopen = () => { clearTimeout(timer); resolve(); };
      socket.onerror = () => { clearTimeout(timer); reject(new Error('无法连接实时转写服务')); };
      socket.onclose = () => { clearTimeout(timer); reject(new Error('实时转写连接已关闭')); };
    });
    socket.onmessage = event => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'transcript') this.options.onTranscript(data.transcript);
        else if (data.type === 'error') { this.options.onError(data.message || '实时转写失败'); void this.stop(); }
        else if (data.type === 'stopped') socket.close(1000, 'recording completed');
      } catch { this.options.onError('实时转写返回了无效数据'); void this.stop(); }
    };
    socket.onerror = () => this.options.onError('实时连接出现网络错误，录音将保存为中断状态');
    socket.onclose = () => {
      if (!this.stopping) this.options.onError('实时连接已中断。已接收内容保存在会议中，请检查后重新开始录音');
      void this.dispose();
    };
    this.processor = new AudioWorkletNode(this.context, 'zhihui-pcm16', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1 });
    this.processor.port.onmessage = event => {
      if (event.data.type === 'flushed') { this.flushed?.(); return; }
      if (event.data.type === 'level') { this.options.onLevel(event.data.value); return; }
      if (event.data.type === 'pcm' && socket.readyState === WebSocket.OPEN) {
        if (socket.bufferedAmount > 1024 * 1024) { this.options.onError('网络过慢，已停止录音以避免丢失更多内容'); void this.stop(); return; }
        socket.send(event.data.buffer);
      }
    };
    for (const stream of this.streams) {
      const source = this.context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      const filter = this.context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 7600;
      source.connect(filter).connect(this.processor);
    }
    // A silent output keeps the worklet scheduled without feeding microphone sound back.
    const silence = this.context.createGain(); silence.gain.value = 0;
    this.processor.connect(silence).connect(this.context.destination);
    microphone.getAudioTracks()[0].onended = () => { if (!this.stopping) { this.options.onError('麦克风已断开'); void this.stop(); } };
  }

  async stop(): Promise<void> {
    if (this.stopping || this.closed) return;
    this.stopping = true;
    try {
      if (this.processor) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 500); this.flushed = () => { clearTimeout(timer); resolve(); }; this.processor!.port.postMessage('flush'); });
      this.processor?.disconnect();
      this.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'stop' }));
        // Provider final text and WAV finalization arrive before server closes.
        const socket = this.socket;
        await new Promise<void>(resolve => { const timer = setTimeout(resolve, 15000); socket.addEventListener('close', () => { clearTimeout(timer); resolve(); }, { once: true }); });
      }
    } catch (error) { this.options.onError(messageOf(error)); }
    finally { await this.dispose(); }
  }

  private async dispose() {
    if (this.closed) return;
    this.closed = true;
    this.processor?.disconnect();
    this.streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    this.socket?.close();
    await this.context?.close().catch(() => undefined);
    this.options.onClosed();
  }
}
