// Pure sample-clock segmentation, shared by the browser and regression tests.
class SilenceSegmenter {
  constructor(rate, emit, {threshold = 0.008, silenceSeconds = 2, maxSeconds = 55} = {}) {
    this.rate = rate; this.emit = emit; this.threshold = threshold;
    this.silenceLimit = Math.round(rate * silenceSeconds);
    this.maxFrames = Math.round(rate * maxSeconds);
    this.preLimit = Math.round(rate * 0.25);
    this.reset();
  }
  reset() { this.parts = []; this.pre = []; this.preFrames = 0; this.frames = 0; this.silent = 0; this.voiced = 0; }
  push(samples) {
    // A small fixed analysis window makes the cutoff independent of incoming packet sizes.
    const window = Math.max(1, Math.round(this.rate * 0.01));
    for (let start = 0; start < samples.length; start += window) {
      const block = samples.slice(start, start + window);
      let power = 0; for (const value of block) power += value * value;
      const voice = Math.sqrt(power / block.length) >= this.threshold;
      if (!this.frames && !voice) {
        this.pre.push(block); this.preFrames += block.length;
        while (this.preFrames > this.preLimit && this.pre.length) this.preFrames -= this.pre.shift().length;
        continue;
      }
      if (!this.frames) { this.parts = this.pre; this.frames = this.preFrames; this.pre = []; this.preFrames = 0; }
      this.parts.push(block); this.frames += block.length;
      if (voice) { this.voiced += block.length; this.silent = 0; }
      else this.silent += block.length;
      if (this.silent >= this.silenceLimit || this.frames >= this.maxFrames) this.flush();
    }
  }
  flush() {
    // Suppress isolated clicks; retain the complete spoken segment, including its silence tail.
    const valid = this.voiced >= this.rate * 0.12;
    const parts = this.parts, frames = this.frames;
    this.reset();
    if (valid) {
      const pcm = new Float32Array(frames); let offset = 0;
      for (const part of parts) { pcm.set(part, offset); offset += part.length; }
      this.emit(pcm);
    }
  }
}
function pcmWav(samples, rate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2), view = new DataView(buffer);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const value = Math.max(-1, Math.min(1, samples[i])); view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
  return buffer;
}
if (typeof module !== 'undefined') module.exports = {SilenceSegmenter, pcmWav};
