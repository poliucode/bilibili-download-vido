"""One request per worker. stdout is reserved for UTF-8 JSON Lines."""
from __future__ import annotations

import ctypes
import hashlib
import http.cookiejar
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import yt_dlp
from yt_dlp.version import __version__
from yt_dlp.cookies import YoutubeDLCookieJar
from watermark import WatermarkError, extract_frame, process_video

PROTOCOL_VERSION = 1
MAX_COMMAND = 2 * 1024 * 1024
SEQUENCE = 0
REQUEST_ID = ''
JOB_HANDLE = None


def emit(event_type: str, **payload) -> None:
    global SEQUENCE
    SEQUENCE += 1
    print(json.dumps({
        'protocolVersion': PROTOCOL_VERSION, 'requestId': REQUEST_ID,
        'seq': SEQUENCE, 'type': event_type, **payload
    }, ensure_ascii=False), flush=True)


class UserError(Exception):
    pass


class QuietLogger:
    def debug(self, message):
        pass

    def warning(self, message):
        pass

    def error(self, message):
        pass


def safe_error(error: Exception) -> str:
    if isinstance(error, (UserError, WatermarkError)):
        return str(error)
    message = str(error).lower()
    if '429' in message or '-412' in message or 'risk' in message:
        return '平台暂时限制访问，请稍后重试，或在官方页面完成验证。'
    if '403' in message or '412' in message:
        return '平台拒绝访问，请检查登录状态或稍后重试。未降低所选画质。'
    if 'login' in message or 'premium' in message or 'permission' in message:
        return '当前会话无法获取该内容，请导入有效的 B 站 Cookie，并检查账号权限。'
    if 'timed out' in message or 'timeout' in message:
        return '网络请求超时，请检查网络后重试。'
    if isinstance(error, OSError):
        return '文件或工具操作失败，请检查目录权限、磁盘空间和引擎环境。'
    return '解析或下载失败，请检查视频是否可访问、登录是否有效，或更新下载引擎。'


def normalize_url(value: str) -> str:
    if not isinstance(value, str) or len(value) > 2048:
        raise UserError('视频地址无效。')
    value = value.strip()
    if re.fullmatch(r'BV[0-9A-Za-z]{10}', value):
        value = f'https://www.bilibili.com/video/{value}'
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'https' or parsed.username or parsed.password or parsed.port
            or parsed.hostname not in ('www.bilibili.com', 'bilibili.com', 'm.bilibili.com', 'b23.tv')):
        raise UserError('仅支持 HTTPS B 站普通视频链接。')
    if parsed.hostname == 'b23.tv':
        if not re.fullmatch(r'/[0-9A-Za-z]+/?', parsed.path):
            raise UserError('短链接格式无效。')
        return f'https://b23.tv{parsed.path}'
    match = re.fullmatch(r'/video/(BV[0-9A-Za-z]{10})/?', parsed.path)
    if not match:
        raise UserError('MVP 仅支持普通 BV 投稿视频。')
    try:
        page = int(urllib.parse.parse_qs(parsed.query).get('p', ['1'])[0])
    except ValueError:
        raise UserError('分 P 序号无效。') from None
    if not 1 <= page <= 10000:
        raise UserError('分 P 序号无效。')
    return f'https://www.bilibili.com/video/{match[1]}?p={page}'


class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        target = normalize_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, target)


def filter_cookies(text: str) -> str:
    if not isinstance(text, str) or len(text.encode('utf-8')) > 1024 * 1024:
        raise UserError('Cookie 文件过大或格式无效。')
    rows = ['# Netscape HTTP Cookie File']
    for line in text.lstrip('\ufeff').splitlines():
        if line.startswith('#') and not line.startswith('#HttpOnly_'):
            continue
        columns = line.split('\t')
        if len(columns) != 7:
            continue
        domain = columns[0].removeprefix('#HttpOnly_').lower().lstrip('.')
        if domain == 'bilibili.com' or domain.endswith('.bilibili.com'):
            if (re.fullmatch(r'[a-z0-9.-]+', domain) and columns[1] in ('TRUE', 'FALSE')
                    and columns[3] in ('TRUE', 'FALSE') and columns[4].isdigit()
                    and columns[2].startswith('/') and columns[5] and '\r' not in line and '\x00' not in line):
                rows.append(line)
    if len(rows) == 1:
        raise UserError('文件中没有有效的 B 站 Cookie，请使用 Netscape cookies.txt 格式。')
    return '\n'.join(rows) + '\n'


class Provider:
    def __init__(self, cookie_text: str | None, tools: str | None = None):
        self.tools = tools
        self.jar = YoutubeDLCookieJar()
        if cookie_text:
            self.jar.load(io.StringIO(filter_cookies(cookie_text)), ignore_discard=True, ignore_expires=False)
        self.opener = urllib.request.build_opener(
            SafeRedirect(), urllib.request.HTTPCookieProcessor(self.jar))

    def api(self, endpoint: str) -> dict:
        request = urllib.request.Request(f'https://api.bilibili.com/{endpoint}', headers={
            'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.bilibili.com/'
        })
        with self.opener.open(request, timeout=25) as response:
            payload = json.load(response)
        if payload.get('code') != 0:
            if payload.get('code') == -101:
                raise UserError('登录会话已失效，请重新导入 Cookie。')
            if payload.get('code') in (-412, -352):
                raise UserError('平台暂时限制访问，请稍后重试或在官方页面完成验证。')
            raise UserError('视频信息不可用，请检查官方页面中的访问权限。')
        return payload['data']

    def resolve(self, value: str, page: int | None = None) -> tuple[str, dict, int]:
        url = normalize_url(value)
        if urllib.parse.urlsplit(url).hostname == 'b23.tv':
            with self.opener.open(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'}),
                                  timeout=25) as response:
                url = normalize_url(response.url)
            if urllib.parse.urlsplit(url).hostname == 'b23.tv':
                raise UserError('短链接未指向受支持的普通视频。')
        bvid = re.search(r'/video/(BV[0-9A-Za-z]{10})', url)[1]
        selected = page or int(urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['p'][0])
        if not isinstance(selected, int) or isinstance(selected, bool) or not 1 <= selected <= 10000:
            raise UserError('分 P 序号无效。')
        metadata = self.api(f'x/web-interface/view?bvid={bvid}')
        parts = metadata.get('pages', [])
        if not any(part.get('page') == selected for part in parts):
            raise UserError('指定的分 P 不存在。')
        if metadata.get('is_upower_exclusive'):
            raise UserError('MVP 暂不支持充电专属内容。')
        return f'https://www.bilibili.com/video/{bvid}?p={selected}', metadata, selected

    def options(self) -> dict:
        return {
            'quiet': True, 'no_warnings': True, 'logger': QuietLogger(),
            'noplaylist': True, 'socket_timeout': 25,
            'retries': 2, 'fragment_retries': 2, 'extractor_retries': 1,
            'ffmpeg_location': self.tools or None
        }

    def extract(self, url: str) -> dict:
        with self.downloader() as downloader:
            info = downloader.extract_info(url, download=False)
        if not info or info.get('_type') in ('playlist', 'multi_video'):
            raise UserError('解析器未返回单个分 P，请重新选择。')
        return info

    def downloader(self, overrides: dict | None = None):
        downloader = yt_dlp.YoutubeDL({**self.options(), **(overrides or {})})
        for cookie in self.jar:
            downloader.cookiejar.set_cookie(cookie)
        return downloader

    def probe(self, value: str, page: int | None = None) -> dict:
        url, metadata, selected = self.resolve(value, page)
        info = self.extract(url)
        formats = [format_option(item) for item in info.get('formats', [])
                   if item.get('vcodec') != 'none' or item.get('acodec') != 'none']
        formats = [item for item in formats if item['kind'] == 'audio' or item['height'] > 0]
        if not any(item['kind'] != 'audio' for item in formats):
            raise UserError('未取得可用视频轨道，请检查账号权限。')
        return {
            'bvid': metadata['bvid'], 'title': metadata['title'],
            'author': metadata.get('owner', {}).get('name', ''),
            'thumbnail': metadata.get('pic', ''), 'currentPage': selected,
            'duration': info.get('duration') or 0, 'formats': formats,
            'parts': [{'page': part['page'], 'cid': str(part['cid']),
                       'title': part['part'], 'duration': part.get('duration', 0)}
                      for part in metadata['pages']]
        }


def format_option(item: dict) -> dict:
    video = item.get('vcodec') not in ('none', None)
    audio = item.get('acodec') not in ('none', None)
    kind = 'combined' if video and audio else 'video' if video else 'audio'
    identity = [str(item.get('format_id', '')), item.get('vcodec') or 'none',
                item.get('acodec') or 'none', item.get('width') or 0, item.get('height') or 0,
                item.get('fps') or 0, item.get('dynamic_range') or 'SDR']
    key = hashlib.sha256(json.dumps(identity).encode()).hexdigest()[:24]
    return {
        'key': key, 'id': identity[0], 'kind': kind,
        'label': item.get('format_note') or item.get('format') or identity[0],
        'width': identity[3], 'height': identity[4], 'fps': identity[5],
        'codec': identity[1], 'audioCodec': identity[2], 'dynamicRange': identity[6],
        'bitrate': item.get('tbr') or item.get('abr') or 0,
        'size': item.get('filesize') or item.get('filesize_approx')
    }


def safe_filename(value: str) -> str:
    result = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', value).strip(' .')[:80]
    if not result or result.split('.')[0].upper() in {
        'CON', 'PRN', 'AUX', 'NUL', *[f'COM{i}' for i in range(1, 10)], *[f'LPT{i}' for i in range(1, 10)]
    }:
        result = f'video_{result}'
    return result


def find_tool(name: str, tools: str | None) -> str:
    candidate = Path(tools, f'{name}.exe' if os.name == 'nt' else name) if tools else None
    found = str(candidate) if candidate and candidate.is_file() else shutil.which(name)
    if not found:
        raise UserError(f'缺少 {name}，请重新安装完整客户端。')
    return found


def attach_windows_job() -> None:
    # 将媒体子进程纳入随 worker 生命周期关闭的 Job，避免只杀 Python 后遗留 ffmpeg。
    global JOB_HANDLE
    if os.name != 'nt':
        return
    from ctypes import wintypes

    class BasicLimit(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_int64), ('job_time', ctypes.c_int64),
                    ('flags', wintypes.DWORD), ('min_working', ctypes.c_size_t),
                    ('max_working', ctypes.c_size_t), ('active_limit', wintypes.DWORD),
                    ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]

    class IoCounters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_uint64) for name in ('read_ops', 'write_ops', 'other_ops',
                                                      'read_bytes', 'write_bytes', 'other_bytes')]

    class ExtendedLimit(ctypes.Structure):
        _fields_ = [('basic', BasicLimit), ('io', IoCounters), ('process_mem', ctypes.c_size_t),
                    ('job_mem', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    kernel.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    kernel.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateJobObjectW(None, None)
    limits = ExtendedLimit()
    limits.basic.flags = 0x2000
    if not handle or not kernel.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
        raise UserError('无法初始化下载进程隔离，请重新启动客户端。')
    if not kernel.AssignProcessToJobObject(handle, kernel.GetCurrentProcess()):
        kernel.CloseHandle(handle)
        raise UserError('无法建立下载进程树管理，请检查系统进程限制。')
    JOB_HANDLE = handle


def verify_media(path: Path, video: dict, audio: dict | None, duration: float, tools: str | None) -> dict:
    result = subprocess.run([
        find_tool('ffprobe', tools), '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)
    ], capture_output=True, timeout=60, creationflags=0x08000000 if os.name == 'nt' else 0)
    if result.returncode != 0:
        raise UserError('媒体校验失败，已保留临时文件。')
    data = json.loads(result.stdout)
    videos = [item for item in data.get('streams', []) if item['codec_type'] == 'video']
    audios = [item for item in data.get('streams', []) if item['codec_type'] == 'audio']
    if not videos or (audio or video['kind'] == 'combined') and not audios:
        raise UserError('成品缺少预期的视频或音频轨道，未标记成功。')
    actual = videos[0]
    if actual.get('height') != video['height'] or actual.get('width') != video['width']:
        raise UserError('成品分辨率与所选轨道不符，未标记成功。')
    expected_codec = {'avc': 'h264', 'h264': 'h264', 'hev': 'hevc', 'hvc': 'hevc', 'av01': 'av1'}
    codec = next((target for prefix, target in expected_codec.items() if video['codec'].startswith(prefix)), None)
    if codec and actual.get('codec_name') != codec:
        raise UserError('成品视频编码与选择不符，未标记成功。')
    if audio and audio.get('audioCodec'):
        expected_audio = {'mp4a': 'aac', 'flac': 'flac', 'opus': 'opus', 'ec-3': 'eac3', 'ac-3': 'ac3'}
        audio_codec = next((target for prefix, target in expected_audio.items()
                            if audio['audioCodec'].startswith(prefix)), None)
        if audio_codec and audios[0].get('codec_name') != audio_codec:
            raise UserError('成品音频编码与选择不符，未标记成功。')
    rate = actual.get('avg_frame_rate') or '0/1'
    numerator, denominator = rate.split('/')
    actual_fps = float(numerator) / max(float(denominator), 1)
    if video['fps'] and abs(actual_fps - video['fps']) > 1:
        raise UserError('成品帧率与选择不符，未标记成功。')
    actual_duration = float(data.get('format', {}).get('duration') or 0)
    if duration and abs(actual_duration - duration) > max(3, duration * 0.02):
        raise UserError('成品时长异常，可能不完整，未标记成功。')
    return {'duration': actual_duration, 'videoCodec': actual.get('codec_name'),
            'audioCodec': audios[0].get('codec_name') if audios else None,
            'width': actual.get('width'), 'height': actual.get('height'), 'fps': actual_fps}


def download(provider: Provider, command: dict) -> None:
    attach_windows_job()
    find_tool('ffmpeg', provider.tools)
    find_tool('ffprobe', provider.tools)
    url, metadata, page = provider.resolve(command['url'], command.get('page'))
    info = provider.extract(url)
    requested_video = command['video']
    requested_audio = command.get('audio')
    formats = info.get('formats', [])
    video = next((item for item in formats if format_option(item)['key'] == requested_video['key']), None)
    audio = next((item for item in formats if requested_audio and
                  format_option(item)['key'] == requested_audio['key']), None)
    if not video or requested_audio and not audio:
        raise UserError('所选格式已变化或不可用，请重新解析选择；没有自动降低画质。')
    chosen_video = format_option(video)
    chosen_audio = format_option(audio) if audio else None
    if chosen_video['kind'] == 'audio' or chosen_video['kind'] == 'video' and not audio:
        raise UserError('视频与音轨选择不完整。')
    container = command.get('container')
    if container not in ('mp4', 'mkv'):
        raise UserError('输出容器无效。')
    output = Path(command['outputDirectory']).resolve()
    if not output.is_dir():
        raise UserError('下载目录不存在，请重新选择。')
    estimated = sum(item.get('filesize') or item.get('filesize_approx') or 0 for item in [video, audio] if item)
    if shutil.disk_usage(output).free < max(100 * 1024 * 1024, estimated * 2.1):
        raise UserError('磁盘可用空间不足，请选择其他目录。')
    part = next(item for item in metadata['pages'] if item['page'] == page)
    basename = safe_filename(f"{metadata['title'][:35]}_{metadata['bvid']}_P{page:02d}_{part['part'][:20]}")
    task_dir = output / '.vido-partial' / command['taskId']
    task_dir.mkdir(parents=True, exist_ok=True)
    last_progress = [0.0]

    def progress(event: dict):
        if event['status'] == 'downloading' and time.monotonic() - last_progress[0] >= 0.25:
            last_progress[0] = time.monotonic()
            total = event.get('total_bytes') or event.get('total_bytes_estimate')
            downloaded = event.get('downloaded_bytes') or 0
            emit('progress', bytes=downloaded, total=total,
                 speed=event.get('speed') or 0,
                 percent=min(100, downloaded / total * 100) if total else None,
                 message='正在下载视频／音频轨道')

    def selector(_context):
        if audio:
            yield {
                'format_id': f"{video['format_id']}+{audio['format_id']}", 'ext': container,
                'requested_formats': [video, audio],
                'protocol': f"{video['protocol']}+{audio['protocol']}"
            }
        else:
            yield video

    def postprocess(event: dict):
        if event['status'] == 'started':
            emit('stage', stage='merging', message='正在无重编码封装，保留平台编码')

    options = {
        **provider.options(), 'format': selector, 'outtmpl': str(task_dir / 'media.%(ext)s'),
        'merge_output_format': container, 'progress_hooks': [progress],
        'postprocessor_hooks': [postprocess], 'overwrites': False,
        'postprocessors': [{'key': 'FFmpegVideoRemuxer', 'preferedformat': container}]
    }
    emit('stage', stage='downloading', message='正在获取选定轨道，保持原编码')
    with provider.downloader(options) as downloader:
        downloader.process_ie_result(info, download=True)
    media = task_dir / f'media.{container}'
    if not media.is_file() or media.stat().st_size == 0:
        raise UserError('未生成预期容器文件，已保留下载轨道。')
    emit('stage', stage='verifying', message='检查轨道、编码、分辨率、帧率和时长')
    verification = verify_media(media, chosen_video, chosen_audio, info.get('duration') or 0, provider.tools)
    target = output / f'{basename}.{container}'
    index = 1
    while target.exists():
        target = output / f'{basename}_{index}.{container}'
        index += 1
    media.rename(target)
    shutil.rmtree(task_dir, ignore_errors=True)
    emit('completed', filePath=str(target), verification=verification, message='下载完成，媒体校验通过')


def execute(command: dict) -> None:
    if command.get('action') in ('watermark_inspect', 'watermark_process'):
        attach_windows_job()
        tools = command.get('toolsDirectory')
        ffmpeg, ffprobe = find_tool('ffmpeg', tools), find_tool('ffprobe', tools)
        if command['action'] == 'watermark_inspect':
            emit('result', data=extract_frame(command, ffmpeg, ffprobe))
        else:
            process_video(command, ffmpeg, ffprobe, emit)
        return
    cookie_text = command.get('cookies')
    provider = Provider(cookie_text, command.get('toolsDirectory'))
    action = command.get('action')
    if action == 'health':
        find_tool('ffmpeg', provider.tools)
        find_tool('ffprobe', provider.tools)
        emit('result', data={'version': __version__, 'message': f'yt-dlp {__version__} · 媒体工具就绪'})
    elif action == 'auth':
        if not cookie_text:
            raise UserError('未导入 Cookie。')
        account = provider.api('x/web-interface/nav')
        if not account.get('isLogin'):
            raise UserError('Cookie 会话无效，请先登录官方网页再导出。')
        emit('result', data={'name': account.get('uname', '已登录'), 'cookies': filter_cookies(cookie_text)})
    elif action == 'probe':
        emit('result', data=provider.probe(command['url'], command.get('page')))
    elif action == 'download':
        download(provider, command)
    else:
        raise UserError('不支持的引擎命令。')


def main() -> int:
    global REQUEST_ID
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8')
    try:
        line = sys.stdin.readline(MAX_COMMAND + 1)
        if len(line) > MAX_COMMAND:
            raise UserError('引擎请求过大。')
        command = json.loads(line)
        REQUEST_ID = str(command.get('requestId', ''))
        execute(command)
        return 0
    except Exception as error:
        emit('error', message=safe_error(error))
        return 1


if __name__ == '__main__':
    sys.exit(main())
