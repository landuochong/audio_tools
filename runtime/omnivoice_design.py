"""Local OmniVoice voice-design service for the selected low whisper preset."""
import asyncio
import base64
import io
import json
import os
from concurrent.futures import ThreadPoolExecutor

os.environ.setdefault('PYTORCH_ENABLE_MPS_FALLBACK', '1')
import numpy as np
import soundfile as sf
import torch
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response, StreamingResponse
from omnivoice import OmniVoice
from pydantic import BaseModel, Field

MODEL_ID = os.getenv('OMNIVOICE_MODEL', 'k2-fsa/OmniVoice')
INSTRUCTION = 'female, young adult, low pitch, whisper'
RATE = 24000
worker = ThreadPoolExecutor(max_workers=1)
model = None
app = FastAPI(title='Voice Studio OmniVoice design', docs_url=None, redoc_url=None)
lock = asyncio.Lock()


class Speech(BaseModel):
    text: str = Field(min_length=1, max_length=500)
    format: str = Field(default='wav', pattern='^wav$')


@app.get('/health')
def health():
    return {'ready': True, 'loaded': model is not None, 'provider': 'omnivoice_local',
            'preset': '低音耳语', 'streaming': False}


def render(text):
    global model
    if model is None:
        device = 'mps' if torch.backends.mps.is_available() else 'cpu'
        model = OmniVoice.from_pretrained(MODEL_ID, device_map=device,
                                          dtype=torch.float16 if device == 'mps' else torch.float32)
    output = model.generate(text=text, instruct=INSTRUCTION, num_step=16, speed=1.0)
    if not output:
        raise RuntimeError('No audio generated')
    audio = np.asarray(output[0], dtype=np.float32).reshape(-1)
    if not len(audio) or not np.isfinite(audio).all():
        raise RuntimeError('Invalid audio generated')
    pcm = (np.clip(audio, -1, 1) * 32767).astype('<i2').tobytes()
    return pcm


async def make_audio(text, request):
    if not text.strip():
        raise HTTPException(400, 'Empty speech text')
    async with lock:
        if await request.is_disconnected():
            raise HTTPException(499, 'Request cancelled')
        future = asyncio.get_running_loop().run_in_executor(worker, render, text.strip())
        try:
            return await asyncio.shield(future)
        except asyncio.CancelledError:
            await future
            raise


@app.post('/synthesize')
async def synthesize(payload: Speech, request: Request):
    pcm = await make_audio(payload.text, request)
    buffer = io.BytesIO()
    sf.write(buffer, np.frombuffer(pcm, dtype='<i2'), RATE, format='WAV', subtype='PCM_16')
    return Response(buffer.getvalue(), media_type='audio/wav')


@app.post('/stream')
async def stream(payload: Speech, request: Request):
    async def events():
        try:
            pcm = await make_audio(payload.text, request)
            yield json.dumps({'type': 'audio', 'rate': RATE,
                              'pcm': base64.b64encode(pcm).decode('ascii')}) + '\n'
            yield '{"type":"done"}\n'
        except Exception as error:
            yield json.dumps({'type': 'error', 'message': str(error)}) + '\n'
    return StreamingResponse(events(), media_type='application/x-ndjson')
