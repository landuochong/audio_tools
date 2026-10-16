// Capture never waits for ASR or TTS, and does not route the microphone to speakers.
class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.buffer = new Float32Array(1024); this.offset = 0; this.stopped = false;
    this.port.onmessage = event => {
      if (event.data === 'stop') {
        this.stopped = true;
        if (this.offset) this.port.postMessage(this.buffer.slice(0, this.offset));
        this.port.postMessage('stopped');
      }
    };
  }
  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel) for (const sample of channel) {
      this.buffer[this.offset++] = sample;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(1024); this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
