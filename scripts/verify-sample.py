"""Explicit user-provided sample acceptance; no browser cookies are read."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]


def run(command: dict) -> dict:
    process = subprocess.Popen([sys.executable, '-u', str(ROOT / 'engine' / 'worker.py')],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, text=True, encoding='utf-8')
    process.stdin.write(json.dumps({**command, 'requestId': str(uuid.uuid4())}) + '\n')
    process.stdin.close()
    result = None
    for line in process.stdout:
        event = json.loads(line)
        if event['type'] in ('result', 'completed', 'error'):
            result = event
        else:
            print(json.dumps(event, ensure_ascii=False), flush=True)
    process.wait(timeout=15)
    if not result or result['type'] == 'error' or process.returncode:
        raise RuntimeError(result.get('message') if result else 'Worker exited without result')
    return result


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser()
    parser.add_argument('url')
    parser.add_argument('--output', default=str(ROOT / '.test-output' / 'downloads'))
    args = parser.parse_args()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    metadata = run({'action': 'probe', 'url': args.url})['data']
    video = sorted((item for item in metadata['formats'] if item['kind'] == 'video' and
                    item['codec'].startswith('avc')), key=lambda item: (item['height'], item['fps']), reverse=True)[0]
    audio = max((item for item in metadata['formats'] if item['kind'] == 'audio'), key=lambda item: item['bitrate'])
    completed = run({
        'action': 'download', 'url': args.url, 'page': metadata['currentPage'],
        'video': video, 'audio': audio, 'container': 'mp4',
        'outputDirectory': str(output), 'taskId': str(uuid.uuid4())
    })
    report = {
        'bvid': metadata['bvid'], 'page': metadata['currentPage'], 'title': metadata['title'],
        'auth': 'anonymous', 'video': video, 'audio': audio,
        'filePath': completed['filePath'], 'verification': completed['verification']
    }
    (output.parent / 'sample-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
