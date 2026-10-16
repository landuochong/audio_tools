"""Native-rate callback playback with continuous resampling across model chunks."""
from collections import deque
import queue
import threading
import time
import numpy as np
import sounddevice as sd
import soxr


class AudioBuffer:
    def __init__(self):
        self.blocks = deque()
        self.offset = 0
        self.frames = 0
        self.ended = False
        self.lock = threading.Lock()

    def append(self, samples):
        if not len(samples):
            return
        with self.lock:
            self.blocks.append(samples)
            self.frames += len(samples)

    def finish(self):
        with self.lock:
            self.ended = True

    def read_into(self, output):
        # Callback does no I/O, model work or resampling. It only copies buffered
        # samples into the soundcard's requested frame count, across boundaries.
        output.fill(0)
        written = 0
        with self.lock:
            while self.blocks and written < len(output):
                block = self.blocks[0]
                count = min(len(block)-self.offset, len(output)-written)
                output[written:written+count, :] = block[self.offset:self.offset+count, None]
                self.offset += count
                written += count
                self.frames -= count
                if self.offset == len(block):
                    self.blocks.popleft()
                    self.offset = 0
            return written, self.ended and not self.frames


class StreamPlayer:
    def __init__(self, devices, stopped, stream_factory=None, prebuffer_seconds=1.6,
                 device_query=None):
        self.prebuffer_seconds = max(0, prebuffer_seconds)
        self.stopped = stopped
        self.queues = [queue.Queue(maxsize=1000) for _ in devices]
        self.errors = []
        self.first_play_at = None
        self.underflows = 0
        self.device_underflows = 0
        self.buffer_starvations = 0
        self.factory = stream_factory or sd.OutputStream
        self.device_query = device_query or sd.query_devices
        self.finished = False
        self.threads = [threading.Thread(target=self.run, args=(device, q), daemon=True)
                        for device, q in zip(devices, self.queues)]
        for thread in self.threads:
            thread.start()

    def run(self, device, chunks):
        stream = None
        try:
            info = self.device_query(device)
            native_rate = int(info['default_samplerate'])
            channels = min(2, int(info['max_output_channels']))
            if channels < 1:
                raise ValueError('Device has no output channels')
            buffer = AudioBuffer()
            drained = threading.Event()
            resampler = None
            source_rate = None
            eof = False

            def callback(output, frames, timing, status):
                if self.stopped.is_set():
                    output.fill(0)
                    raise sd.CallbackAbort
                if status.output_underflow:
                    self.device_underflows += 1
                    self.underflows += 1
                count, complete = buffer.read_into(output)
                if count and self.first_play_at is None:
                    self.first_play_at = time.perf_counter()
                if count < frames and not complete:
                    self.buffer_starvations += 1
                    self.underflows += 1
                if complete:
                    raise sd.CallbackStop

            while not self.stopped.is_set():
                if not eof:
                    try:
                        item = chunks.get(timeout=.05)
                    except queue.Empty:
                        continue
                    if item is None:
                        eof = True
                        if resampler is not None:
                            buffer.append(resampler.resample_chunk(np.empty(0, dtype=np.float32), last=True))
                        buffer.finish()
                    else:
                        pcm, rate = item
                        if len(pcm) % 2 or (source_rate is not None and source_rate != rate):
                            raise ValueError('Invalid PCM chunk or changing sample rate')
                        if source_rate is None:
                            source_rate = rate
                            if rate != native_rate:
                                resampler = soxr.ResampleStream(rate, native_rate, 1, dtype='float32', quality='HQ')
                        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32)/32768
                        buffer.append(resampler.resample_chunk(samples) if resampler is not None else samples)
                if stream is None and buffer.frames and (eof or buffer.frames >= native_rate*self.prebuffer_seconds):
                    stream = self.factory(device=device, samplerate=native_rate, channels=channels,
                        dtype='float32', latency='high', blocksize=0, callback=callback,
                        finished_callback=drained.set)
                    stream.start()
                if eof:
                    if stream is None or drained.wait(.05):
                        break
        except Exception as error:
            self.errors.append(str(error))
            self.stopped.set()
        finally:
            if stream is not None:
                if self.stopped.is_set():
                    stream.abort()
                else:
                    stream.stop()
                stream.close()

    def append(self, pcm, rate):
        if self.errors:
            raise RuntimeError(self.errors[0])
        if self.finished:
            raise RuntimeError('Playback already finished')
        for chunks in self.queues:
            chunks.put_nowait((pcm, rate))

    def finish(self):
        if not self.finished:
            self.finished = True
            for chunks in self.queues:
                chunks.put_nowait(None)
        for thread in self.threads:
            thread.join()
        if self.errors:
            raise RuntimeError(self.errors[0])
