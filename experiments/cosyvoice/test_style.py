"""Isolated CosyVoice3 timbre/style trial; writes only ignored local audio."""
import json
import time
from pathlib import Path

import numpy as np
import soundfile as sf
from mlx_audio.tts.generate import load_audio
from mlx_audio.tts.utils import load_model

root = Path(__file__).resolve().parents[2]
out = root / 'data/omnivoice-test'
out.mkdir(parents=True, exist_ok=True)
reference = root / 'data/reference/voice.wav'
reference_text = (root / 'data/reference/transcript.txt').read_text(encoding='utf-8').strip()
text = '今天辛苦啦。先坐下来休息一会儿，不用急着把所有事情都做完。你想聊聊的话，我就在这里听你说。'
model_id = 'mlx-community/Fun-CosyVoice3-0.5B-2512-4bit'
print('Loading', model_id, flush=True)
started = time.perf_counter()
model = load_model(model_id)
print('loaded_seconds', round(time.perf_counter() - started, 2), flush=True)
ref = load_audio(str(reference), sample_rate=model.sample_rate)
for name, kwargs in [
    ('cosyvoice3-clone', {'ref_text': reference_text}),
    ('cosyvoice3-whisper', {'instruct_text': '请保持参考音色，用贴近耳边的轻柔耳语说话，音调略低，语速舒缓。'}),
]:
    started = time.perf_counter()
    pieces = [np.asarray(result.audio, dtype=np.float32) for result in model.generate(
        text=text, ref_audio=ref, stt_model=None, verbose=False, stream=False, **kwargs)]
    audio = np.concatenate(pieces)
    path = out / f'{name}.wav'
    sf.write(path, audio, model.sample_rate, subtype='PCM_16')
    print(json.dumps({'name': name, 'path': str(path), 'generation_seconds': round(time.perf_counter() - started, 2),
                      'duration': round(len(audio) / model.sample_rate, 2), 'rate': model.sample_rate}, ensure_ascii=False), flush=True)
