import json, time, os
from pathlib import Path
os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
import torch
import soundfile as sf
from omnivoice import OmniVoice
root = Path(__file__).resolve().parents[2]
out = root / 'data/omnivoice-test'
out.mkdir(parents=True, exist_ok=True)
ref = root / 'data/reference/voice.wav'
ref_text = (ref.parent / 'transcript.txt').read_text(encoding='utf-8').strip()
start = time.perf_counter()
print('Loading OmniVoice on MPS', flush=True)
model = OmniVoice.from_pretrained('k2-fsa/OmniVoice', device_map='mps', dtype=torch.float16)
load_seconds = time.perf_counter() - start
print(f'Model ready in {load_seconds:.2f}s', flush=True)
results = []
for name, text in [('reference-text', ref_text), ('chat', '今天辛苦啦。先坐下来休息一会儿，不用急着把所有事情都做完。你想聊聊的话，我就在这里听你说。')]:
    start = time.perf_counter()
    audio = model.generate(text=text, ref_audio=str(ref), ref_text=ref_text, num_step=32, speed=1.0)
    seconds = time.perf_counter() - start
    path = out / f'{name}.wav'
    sf.write(path, audio[0], 24000)
    duration = len(audio[0]) / 24000
    result = dict(file=str(path), text=text, generation_seconds=seconds, audio_seconds=duration, rtf=seconds/duration)
    results.append(result)
    print(json.dumps(result, ensure_ascii=False), flush=True)
    (out / 'results.json').write_text(json.dumps(dict(model='k2-fsa/OmniVoice', device='mps', dtype='float16', num_step=32, speed=1.0, load_seconds=load_seconds, results=results), ensure_ascii=False, indent=2))
