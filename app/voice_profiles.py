"""Read local clone references without importing upload routes or model runtimes."""
import json
import re
from pathlib import Path
from fastapi import HTTPException

ROOT = Path(__file__).resolve().parents[1]
VOICE_DIR = ROOT / "data" / "voices"
VOICE_PATTERN = r"^(clone|low_whisper|clone:[a-f0-9]{32})$"


def profile_path(identifier):
    if not re.fullmatch(r'[a-f0-9]{32}', identifier):
        raise HTTPException(404, '音色不存在。')
    return VOICE_DIR / identifier


def get_profile(identifier):
    directory = profile_path(identifier)
    try:
        profile = json.loads((directory / 'profile.json').read_text(encoding='utf-8'))
        if not (directory / 'reference.wav').is_file():
            raise FileNotFoundError()
    except (OSError, ValueError):
        raise HTTPException(404, '音色不存在或参考录音已丢失。')
    return profile


def reference_for(identifier):
    profile = get_profile(identifier)
    return profile_path(identifier) / 'reference.wav', profile['reference_text']


def speech_target(voice, tts_url, design_url):
    if voice == 'low_whisper':
        return design_url, {}
    if voice == 'clone':
        return tts_url, {}
    identifier = voice.removeprefix('clone:')
    get_profile(identifier)
    return tts_url, {'reference_id': identifier}


