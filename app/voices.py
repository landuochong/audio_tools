"""Upload, preview and manage local voice profiles."""
import asyncio
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from app import voice_profiles as store
from app.voice_profiles import profile_path, get_profile

router = APIRouter()


def normalize_reference(data):
    try:
        wav = subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
            '-t', '31', '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'],
            input=data, capture_output=True, check=True, timeout=20).stdout
        samples, rate = sf.read(io.BytesIO(wav), dtype='float32')
    except (OSError, subprocess.SubprocessError, ValueError, RuntimeError) as error:
        raise HTTPException(400, '无法读取参考录音，请上传有效音频。') from error
    duration = len(samples) / rate
    if not 3 <= duration <= 30:
        raise HTTPException(400, '参考录音需要 3–30 秒，请先剪辑后再上传。')
    if not np.isfinite(samples).all() or np.max(np.abs(samples)) < .001:
        raise HTTPException(400, '参考录音为空白或音量过低。')
    # Rewrite the streamed WAV header with its final length before storing it.
    output = io.BytesIO()
    sf.write(output, samples, rate, format='WAV', subtype='PCM_16')
    return output.getvalue(), round(duration, 2)


def save_profile(name, text, data):
    wav, duration = normalize_reference(data)
    store.VOICE_DIR.mkdir(parents=True, exist_ok=True)
    identifier = uuid.uuid4().hex
    profile = {'id': identifier, 'name': name, 'reference_text': text, 'duration': duration}
    temporary = Path(tempfile.mkdtemp(prefix='.upload-', dir=store.VOICE_DIR))
    try:
        (temporary / 'reference.wav').write_bytes(wav)
        (temporary / 'profile.json').write_text(json.dumps(profile, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(temporary, profile_path(identifier))
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return profile


@router.get('/api/voices')
def list_voices():
    profiles = []
    if store.VOICE_DIR.exists():
        for directory in sorted(store.VOICE_DIR.iterdir()):
            if re.fullmatch(r'[a-f0-9]{32}', directory.name):
                try:
                    profiles.append(get_profile(directory.name))
                except HTTPException:
                    pass
    return {'voices': profiles}


@router.post('/api/voices')
async def create_voice(name: str = Form(..., max_length=60),
                       reference_text: str = Form(..., max_length=1000),
                       file: UploadFile = File(...)):
    name, text = name.strip(), reference_text.strip()
    if not name or not text:
        raise HTTPException(400, '请填写音色名称和参考录音的准确原文。')
    data = await file.read(20_000_001)
    if not data or len(data) > 20_000_000:
        raise HTTPException(400, '参考录音为空或超过 20 MB。')
    return await asyncio.to_thread(save_profile, name, text, data)


@router.get('/api/voices/{identifier}/audio')
def reference_audio(identifier: str):
    get_profile(identifier)
    return FileResponse(profile_path(identifier) / 'reference.wav', media_type='audio/wav')


@router.delete('/api/voices/{identifier}')
def delete_voice(identifier: str):
    get_profile(identifier)
    shutil.rmtree(profile_path(identifier))
    return {'deleted': True}
