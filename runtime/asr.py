"""Standalone SenseVoice service for Voice Studio."""

from __future__ import annotations

import os
import re
import time
import wave
from contextlib import asynccontextmanager
from io import BytesIO
from pathlib import Path

import numpy as np
import sherpa_onnx
from fastapi import FastAPI, File, HTTPException, UploadFile


ROOT = Path(__file__).resolve().parents[1]
MODEL_DIR = Path(
    os.environ.get("SENSEVOICE_MODEL_DIR", ROOT.parent / "digitalman" / "resources" / "models" / "sensevoice")
).expanduser().resolve()
MODEL_PATH = MODEL_DIR / "model.int8.onnx"
TOKENS_PATH = MODEL_DIR / "tokens.txt"
MAX_AUDIO_BYTES = int(os.environ.get("LOCAL_ASR_MAX_AUDIO_BYTES", "8000000"))

recognizer: sherpa_onnx.OfflineRecognizer | None = None
TAG_PATTERN = re.compile(r"<\|[^|<>]+\|>")


def load_recognizer() -> sherpa_onnx.OfflineRecognizer:
    missing = [str(path) for path in (MODEL_PATH, TOKENS_PATH) if not path.is_file()]
    if missing:
        raise RuntimeError(
            "SenseVoice model is missing; set SENSEVOICE_MODEL_DIR "
            f"(missing: {', '.join(missing)})"
        )
    return sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(MODEL_PATH),
        tokens=str(TOKENS_PATH),
        num_threads=max(1, int(os.environ.get("LOCAL_ASR_THREADS", "2"))),
        sample_rate=16000,
        feature_dim=80,
        decoding_method="greedy_search",
        use_itn=True,
        debug=False,
    )


def decode_pcm_wav(data: bytes) -> tuple[np.ndarray, int]:
    try:
        with wave.open(BytesIO(data), "rb") as source:
            channels = source.getnchannels()
            sample_width = source.getsampwidth()
            sample_rate = source.getframerate()
            frames = source.readframes(source.getnframes())
    except (EOFError, wave.Error) as error:
        raise ValueError("audio must be a PCM WAV file") from error
    if channels != 1 or sample_width != 2:
        raise ValueError("audio must be mono 16-bit PCM WAV")
    if sample_rate < 8000 or sample_rate > 48000:
        raise ValueError("unsupported WAV sample rate")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if samples.size == 0:
        raise ValueError("audio is empty")
    return samples, sample_rate


def clean_result(text: str) -> str:
    return TAG_PATTERN.sub("", str(text or "")).strip()


def transcribe_wav(data: bytes) -> str:
    if recognizer is None:
        raise RuntimeError("recognizer is not ready")
    samples, sample_rate = decode_pcm_wav(data)
    stream = recognizer.create_stream()
    stream.accept_waveform(sample_rate, samples)
    recognizer.decode_stream(stream)
    return clean_result(stream.result.text)


@asynccontextmanager
async def lifespan(_: FastAPI):
    global recognizer
    recognizer = load_recognizer()
    yield
    recognizer = None


app = FastAPI(title="digitalman-local-asr", lifespan=lifespan)


@app.get("/health")
def health() -> dict:
    return {
        "ok": recognizer is not None,
        "asr_provider": "sherpa_onnx_sensevoice",
        "model": "sensevoice-int8",
    }


@app.post("/api/asr/transcribe")
async def transcribe(audio: UploadFile = File(...), language: str = "zh-CN") -> dict:
    del language  # SenseVoice detects supported languages itself.
    data = await audio.read(MAX_AUDIO_BYTES + 1)
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail="audio is too large")
    started = time.perf_counter()
    try:
        text = transcribe_wav(data)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    if not text:
        raise HTTPException(status_code=422, detail="no speech recognized")
    return {
        "text": text,
        "provider": "sherpa_onnx_sensevoice",
        "duration_ms": round((time.perf_counter() - started) * 1000),
    }
