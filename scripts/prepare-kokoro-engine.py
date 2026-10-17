"""Run in an x64 Visual Studio developer shell before the first Windows build.
Downloads only the pinned native CPU SDK (no model/Python environment/GPU).
The user separately imports the public, hash-checked Kokoro INT8 voice package.
"""
from pathlib import Path
import hashlib
import shutil
import subprocess
import tarfile
import urllib.request

root = Path(__file__).resolve().parent.parent
archive_name = 'sherpa-onnx-v1.13.8-win-x64-shared-MT-Release-lib.tar.bz2'
archive_sha = 'b8eedf41bd6d3779218887b48367bb7a3ece5aaa7667f01f69ee823a12b0a9e7'
cache = root / 'src-tauri/target/kokoro-sdk'
cache.mkdir(parents=True, exist_ok=True)
archive = cache / archive_name
if not archive.exists():
    request = urllib.request.Request(
        'https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/' + archive_name,
        headers={'User-Agent': 'TomatoReader-build'},
    )
    with urllib.request.urlopen(request, timeout=90) as response, archive.open('wb') as output:
        shutil.copyfileobj(response, output)
if hashlib.sha256(archive.read_bytes()).hexdigest() != archive_sha:
    raise SystemExit('Native SDK checksum mismatch; remove the failed cached archive and retry.')
with tarfile.open(archive) as package:
    # Python 3.12+ data filter prevents paths/links escaping this build cache.
    package.extractall(cache, filter='data')
lib = cache / archive_name.removesuffix('.tar.bz2') / 'lib'
engine = root / 'src-tauri/resources/kokoro/engine'
engine.mkdir(parents=True, exist_ok=True)
for name in ('onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll'):
    shutil.copy2(lib / name, engine / name)
if not shutil.which('cl'):
    raise SystemExit('Run this script from the x64 Visual Studio developer shell (cl.exe is required).')
subprocess.run([
    'cl', '/nologo', '/O2', '/MT', '/EHsc', '/std:c++17', '/LD',
    'src-tauri/native/kokoro_bridge.cpp', '/Fosrc-tauri/target/kokoro_bridge.obj',
    '/Fesrc-tauri/resources/kokoro/engine/tomato-kokoro.dll',
    '/link', str(lib / 'sherpa-onnx-c-api.lib'), '/IMPLIB:src-tauri/target/tomato-kokoro.lib',
], cwd=root, check=True)
print('Pinned CPU engine prepared. No model was downloaded.')
