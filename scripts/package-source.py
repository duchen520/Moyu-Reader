"""Create a clean source release without build output or browser/user data."""
from pathlib import Path
import json
import os
import sys
import zipfile

root = Path(__file__).resolve().parent.parent
version = json.loads((root / 'package.json').read_text(encoding='utf-8'))['version']
destination = Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent / f'tomato-reader-v{version}-source.zip'
excluded = {'node_modules', 'target', 'dist', 'test-output', '.git', '.codex', '.agents', '__pycache__', '.venv'}
with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED) as archive:
    for directory, folders, filenames in os.walk(root):
        folders[:] = [name for name in folders if name not in excluded]
        for filename in filenames:
            path = Path(directory) / filename
            relative = path.relative_to(root)
            if path.resolve() == destination.resolve():
                continue
            if path.name.startswith('.env') or path.suffix.lower() in {'.zip', '.log', '.exe', '.pdb', '.dll', '.lib', '.exp', '.obj', '.onnx', '.bin'}:
                continue
            archive.write(path, Path(f'tomato-reader-v{version}') / relative)
print(destination)
