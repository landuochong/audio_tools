"""Start the standalone local UI and two owned model services."""
import os
import signal
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
children = []
PORT = int(os.getenv('VOICE_TOOLS_PORT', '8030'))


def responding(port):
    try:
        urllib.request.urlopen(f'http://127.0.0.1:{port}/' if port == PORT else f'http://127.0.0.1:{port}/health', timeout=1).close()
        return True
    except Exception:
        return False


def shutdown(*args):
    for child in reversed(children):
        if child.poll() is None:
            child.terminate()
    for child in children:
        try:
            child.wait(timeout=8)
        except subprocess.TimeoutExpired:
            child.kill()
    raise SystemExit(0)


signal.signal(signal.SIGINT, shutdown)
signal.signal(signal.SIGTERM, shutdown)
if responding(PORT):
    print(f'工具已经运行：http://127.0.0.1:{PORT}', flush=True)
    if '--no-browser' not in sys.argv:
        webbrowser.open(f'http://127.0.0.1:{PORT}')
    raise SystemExit(0)

# Reuse an existing local Ollama, or own one with cloud inference disabled.
try:
    urllib.request.urlopen('http://127.0.0.1:11434/api/version', timeout=1).close()
except Exception:
    ollama = shutil.which('ollama')
    if ollama:
        chat_env = {**os.environ, 'OLLAMA_HOST': '127.0.0.1:11434', 'OLLAMA_NO_CLOUD': '1'}
        children.append(subprocess.Popen([ollama, 'serve'], env=chat_env))
    else:
        print('聊天建议需要 Ollama 和本地 qwen3.5:9b 模型；语音功能可继续使用。', flush=True)

services = [('.venv-tts', 'runtime.tts:app', 8031), ('.venv-asr', 'runtime.asr:app', 8032), ('.venv', 'app.main:app', PORT)]
for environment, module, port in services:
    if responding(port):
        print(f'复用已运行的本工具服务：{port}', flush=True)
        continue
    executable = ROOT / environment / 'bin/python'
    if not executable.exists():
        print('环境缺失，请运行 scripts/setup.sh', flush=True)
        shutdown()
    env = {**os.environ, 'PYTHONUNBUFFERED': '1', 'TOKENIZERS_PARALLELISM': 'false'}
    children.append(subprocess.Popen([str(executable), '-m', 'uvicorn', module, '--host', '127.0.0.1', '--port', str(port)], cwd=ROOT, env=env))
try:
    for _ in range(30):
        if responding(PORT):
            break
        time.sleep(.2)
    print(f'声间已启动：http://127.0.0.1:{PORT} （模型首次加载请稍等）', flush=True)
    if '--no-browser' not in sys.argv:
        webbrowser.open(f'http://127.0.0.1:{PORT}')
    while True:
        if any(child.poll() is not None for child in children):
            print('一个服务已退出，请查看上方错误。', flush=True)
            break
        time.sleep(1)
finally:
    shutdown()
