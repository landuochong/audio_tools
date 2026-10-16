from __future__ import annotations

import asyncio
import io
import os
import re
import subprocess
import threading
import time
import uuid
from collections import OrderedDict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import httpx
import numpy as np
import sounddevice as sd
import soundfile as sf
from fastapi import FastAPI, HTTPException, Request, UploadFile, File
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parents[1]
TTS_URL = os.getenv('VOICE_TOOLS_TTS_URL', 'http://127.0.0.1:8031')
DESIGN_URL = os.getenv('VOICE_TOOLS_DESIGN_URL', 'http://127.0.0.1:8033')
VOICE_URLS = {'clone': TTS_URL, 'low_whisper': DESIGN_URL}
ASR_URL = os.getenv('VOICE_TOOLS_ASR_URL', 'http://127.0.0.1:8032')
PORT = int(os.getenv('VOICE_TOOLS_PORT', '8030'))
app = FastAPI(title='Voice Studio', docs_url=None, redoc_url=None)
from app.suggestions import router as suggestions_router
app.include_router(suggestions_router)

clips = OrderedDict()
MAX_CLIPS = 12
MAX_CLIP_BYTES = 48_000_000
play_lock = threading.Lock()
play_stop = threading.Event()
play_state = {'active': False, 'devices': [], 'error': None}
executor = ThreadPoolExecutor(max_workers=2)


@app.middleware('http')
async def local_only(request: Request, call_next):
    # Prevent arbitrary websites from operating local playback/recording services.
    host = request.headers.get('host', '').split(':')[0]
    origin = request.headers.get('origin')
    if host not in ('127.0.0.1', 'localhost'):
        return Response('Local access only', status_code=403)
    if origin and origin not in (f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}'):
        return Response('Origin not allowed', status_code=403)
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    return response


async def probe(url):
    try:
        async with httpx.AsyncClient(timeout=2, trust_env=False) as client:
            response = await client.get(url + '/health')
            response.raise_for_status()
            result = response.json()
            return bool(result.get('ready', result.get('ok', False))), result
    except Exception:
        return False, {}


@app.get('/api/status')
async def status():
    tts, asr, design = await asyncio.gather(probe(TTS_URL), probe(ASR_URL), probe(DESIGN_URL))
    return {'tts': tts[0], 'asr': asr[0], 'speed': tts[1].get('speed', 1),
            'model': 'Qwen3-TTS · 原始克隆', 'design': design[0], 'design_loaded': design[1].get('loaded', False), 'playback': dict(play_state)}


def list_outputs():
    devices = []
    for index, device in enumerate(sd.query_devices()):
        if device['max_output_channels']:
            name = device['name']
            devices.append({'id': index, 'name': name, 'channels': device['max_output_channels'],
                'virtual': bool(re.search(r'blackhole|loopback|soundflower|virtual|parrot', name, re.I)),
                'default': index == sd.default.device[1]})
    return devices


@app.get('/api/devices')
def devices():
    return {'outputs': list_outputs()}


@app.post('/api/transcribe')
async def transcribe(file: UploadFile = File(...)):
    data = await file.read(20_000_001)
    if not data or len(data) > 20_000_000:
        raise HTTPException(400, '录音为空或超过 20 MB，请缩短录音。')
    def convert():
        return subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
            '-t', '60', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'],
            input=data, capture_output=True, check=True, timeout=20).stdout
    try:
        wav = await asyncio.to_thread(convert)
        async with httpx.AsyncClient(timeout=90, trust_env=False) as client:
            r = await client.post(ASR_URL + '/api/asr/transcribe', files={'audio': ('recording.wav', wav, 'audio/wav')})
            r.raise_for_status()
            return {'text': r.json()['text']}
    except Exception as error:
        raise HTTPException(502, '识别失败，请确认识别服务已启动且录音包含清晰人声。') from error


class Synthesize(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    voice: str = Field(default='clone', pattern='^(clone|low_whisper)$')


@app.post('/api/synthesize')
async def synthesize(payload: Synthesize):
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, '请输入要说的话。')
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=180, trust_env=False) as client:
            response = await client.post(VOICE_URLS[payload.voice] + '/synthesize', json={'text': text, 'format': 'wav'})
            response.raise_for_status()
        audio, rate = sf.read(io.BytesIO(response.content), dtype='float32', always_2d=True)
        if not len(audio) or not np.isfinite(audio).all():
            raise ValueError('Invalid audio')
        if audio.nbytes > MAX_CLIP_BYTES:
            raise ValueError('Audio too large')
    except Exception as error:
        raise HTTPException(502, '合成失败，请检查本地语音服务；长文本可分成几句再试。') from error
    identifier = uuid.uuid4().hex
    clips[identifier] = (response.content, audio, rate)
    while len(clips) > MAX_CLIPS or sum(v[1].nbytes for v in clips.values()) > MAX_CLIP_BYTES:
        clips.popitem(last=False)
    return {'id': identifier, 'url': f'/api/audio/{identifier}', 'duration': round(len(audio)/rate, 2),
            'seconds': round(time.perf_counter()-started, 2)}


def get_clip(identifier):
    clip = clips.get(identifier)
    if clip is None:
        raise HTTPException(404, '这段音频已过期，请重新合成。')
    return clip


@app.get('/api/audio/{identifier}')
def get_audio(identifier: str):
    data, _, _ = get_clip(identifier)
    return Response(data, media_type='audio/wav', headers={'Content-Disposition': 'inline; filename="voice-studio.wav"'})


class Playback(BaseModel):
    clip_id: str
    devices: list[int] = Field(min_length=1, max_length=2)


def play_device(audio, source_rate, device_id):
    device = sd.query_devices(device_id)
    target_rate = int(device['default_samplerate'])
    channels = min(2, int(device['max_output_channels']))
    # Convert only sample rate/channel count; preserve voice pitch and tempo.
    buffer = io.BytesIO()
    sf.write(buffer, audio, source_rate, format='WAV', subtype='PCM_16')
    raw = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
        '-ar', str(target_rate), '-ac', str(channels), '-f', 'f32le', 'pipe:1'],
        input=buffer.getvalue(), capture_output=True, check=True, timeout=15).stdout
    samples = np.frombuffer(raw, dtype='<f4').reshape(-1, channels)
    block = max(256, target_rate // 50)
    with sd.OutputStream(device=device_id, samplerate=target_rate, channels=channels, dtype='float32') as stream:
        for offset in range(0, len(samples), block):
            if play_stop.is_set():
                stream.abort()
                return
            stream.write(samples[offset:offset + block])


def play_job(audio, rate, selected):
    try:
        jobs = [executor.submit(play_device, audio, rate, device) for device in selected]
        errors = []
        for job in jobs:
            try:
                job.result()
            except Exception as error:
                play_stop.set()
                errors.append(error)
        if errors:
            raise errors[0]
    except Exception as error:
        play_stop.set()
        play_state['error'] = f'播放失败：{error}'
    finally:
        play_state['active'] = False
        play_lock.release()


@app.post('/api/play')
def play(payload: Playback):
    _, audio, rate = get_clip(payload.clip_id)
    selected = list(dict.fromkeys(payload.devices))
    allowed = {d['id'] for d in list_outputs()}
    if any(device not in allowed for device in selected):
        raise HTTPException(400, '所选输出设备已断开，请刷新设备列表。')
    if not play_lock.acquire(blocking=False):
        raise HTTPException(409, '当前仍在播放，请先停止。')
    play_stop.clear()
    play_state.update(active=True, devices=selected, error=None)
    threading.Thread(target=play_job, args=(audio, rate, selected), daemon=True).start()
    return {'playing': True}


@app.post('/api/stop')
def stop():
    play_stop.set()
    return {'stopping': True}


class StreamSpeech(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    voice: str = Field(default='clone', pattern='^(clone|low_whisper)$')
    devices: list[int] = Field(min_length=1, max_length=2)


@app.post('/api/stream')
def stream_and_play(payload: StreamSpeech):
    import base64
    import json
    from fastapi.responses import StreamingResponse
    from app.stream_player import StreamPlayer
    text = payload.text.strip()
    if not text:
        raise HTTPException(400, '请输入要说的话。')
    selected = list(dict.fromkeys(payload.devices))
    allowed = {d['id'] for d in list_outputs()}
    if any(device not in allowed for device in selected):
        raise HTTPException(400, '输出设备已断开，请刷新设备列表。')
    for device in selected:
        try:
            info = sd.query_devices(device)
            sd.check_output_settings(device=device, samplerate=int(info['default_samplerate']),
                                     channels=min(2, info['max_output_channels']), dtype='float32')
        except Exception as error:
            raise HTTPException(400, '所选设备不支持流式格式，请使用普通生成播放。') from error
    if not play_lock.acquire(blocking=False):
        raise HTTPException(409, '请先停止当前播放。')
    play_stop.clear()
    play_state.update(active=True, devices=selected, error=None)

    def events():
        started = time.perf_counter()
        first_chunk = None
        player = StreamPlayer(selected, play_stop)
        chunks = []
        total_bytes = 0
        rate = 24000
        completed = False
        def event(value):
            return json.dumps(value, ensure_ascii=False) + '\n'
        try:
            yield event({'type': 'started'})
            with httpx.Client(timeout=180, trust_env=False) as client:
                with client.stream('POST', VOICE_URLS[payload.voice] + '/stream', json={'text': text}) as response:
                    response.raise_for_status()
                    for line in response.iter_lines():
                        if play_stop.is_set():
                            break
                        if not line:
                            continue
                        item = json.loads(line)
                        if item['type'] == 'error':
                            raise RuntimeError(item.get('message', '语音生成失败'))
                        if item['type'] == 'done':
                            completed = True
                            break
                        if item['type'] != 'audio':
                            continue
                        rate = item['rate']
                        pcm = base64.b64decode(item['pcm'], validate=True)
                        if rate != 24000 or len(pcm) % 2:
                            raise RuntimeError('无效的音频分块')
                        total_bytes += len(pcm)
                        if total_bytes * 2 > MAX_CLIP_BYTES:
                            raise RuntimeError('音频过长，请缩短文本')
                        chunks.append(pcm)
                        player.append(pcm, rate)
                        if first_chunk is None:
                            first_chunk = time.perf_counter()-started
                            yield event({'type': 'first_audio', 'seconds': round(first_chunk, 2)})
            if not completed or play_stop.is_set():
                play_stop.set()
                player.finish()
                yield event({'type': 'cancelled'})
                return
            generation_seconds = time.perf_counter()-started
            yield event({'type': 'generated', 'seconds': round(generation_seconds, 2)})
            player.finish()
            if play_stop.is_set():
                yield event({'type': 'cancelled'})
                return
            audio = np.frombuffer(b''.join(chunks), dtype='<i2').astype(np.float32).reshape(-1, 1)/32768
            buffer = io.BytesIO()
            sf.write(buffer, audio, rate, format='WAV', subtype='PCM_16')
            identifier = uuid.uuid4().hex
            clips[identifier] = (buffer.getvalue(), audio, rate)
            while len(clips) > MAX_CLIPS or sum(v[1].nbytes for v in clips.values()) > MAX_CLIP_BYTES:
                clips.popitem(last=False)
            yield event({'type': 'done', 'id': identifier, 'url': f'/api/audio/{identifier}',
                'duration': round(len(audio)/rate, 2), 'seconds': round(generation_seconds, 2),
                'first_audio_seconds': round(first_chunk or 0, 2),
                'first_play_seconds': round(player.first_play_at-started, 2) if player.first_play_at else None,
                'underflows': player.underflows, 'device_underflows': player.device_underflows,
                'buffer_starvations': player.buffer_starvations})
        except Exception as error:
            play_stop.set()
            play_state['error'] = str(error)
            yield event({'type': 'error', 'message': str(error)})
        finally:
            play_stop.set()
            try:
                player.finish()
            except Exception:
                pass
            play_state['active'] = False
            play_lock.release()
    return StreamingResponse(events(), media_type='application/x-ndjson')


@app.get('/')
def index():
    return FileResponse(ROOT / 'web/index.html')


app.mount('/static', StaticFiles(directory=ROOT / 'web'), name='static')
