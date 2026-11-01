import importlib.metadata
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
destination = ROOT / 'build-resources' / 'licenses'
for name in ('yt-dlp', 'pyinstaller', 'certifi', 'curl-cffi', 'cffi', 'pycparser',
             'brotli', 'websockets', 'pycryptodomex', 'requests', 'urllib3', 'charset-normalizer', 'idna'):
    try:
        package = importlib.metadata.distribution(name)
    except importlib.metadata.PackageNotFoundError:
        continue
    package_dir = destination / name
    package_dir.mkdir(parents=True, exist_ok=True)
    (package_dir / 'METADATA.txt').write_text(package.read_text('METADATA') or f'{name} {package.version}', encoding='utf-8')
    for file in package.files or []:
        if any(token in str(file).lower() for token in ('license', 'copying', 'notice')):
            source = package.locate_file(file)
            if source.is_file():
                shutil.copy2(source, package_dir / (str(file).replace('/', '_').replace('\\', '_')))

for filename in ('LICENSE.txt', 'LICENSE'):
    source = Path(sys.base_prefix) / filename
    if source.is_file():
        shutil.copy2(source, destination / 'Python-LICENSE.txt')
        break

for name in ('react', 'react-dom', 'lucide-react'):
    package_dir = ROOT / 'node_modules' / name
    for filename in ('LICENSE', 'LICENSE.txt', 'LICENSE.md'):
        source = package_dir / filename
        if source.is_file():
            shutil.copy2(source, destination / f'{name}-LICENSE.txt')
            break

version = subprocess.run(['ffmpeg', '-version'], capture_output=True, check=True)
(destination / 'FFmpeg-build.txt').write_bytes(version.stdout)
