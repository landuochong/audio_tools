#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
uv venv --python 3.12 .venv-tts
uv pip install --python .venv-tts/bin/python 'mlx-audio[tts]==0.5.8' 'fastapi==0.115.6' 'uvicorn==0.34.0'
uv venv --python 3.12 .venv-asr
uv pip install --python .venv-asr/bin/python 'sherpa-onnx==1.12.29' 'numpy==1.26.4' 'fastapi==0.115.6' 'python-multipart==0.0.20' 'uvicorn==0.34.0'
