"""Local FFmpeg watermark processing. Never overwrites the input media."""
from __future__ import annotations

import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import time


class WatermarkError(Exception):
    pass


def run_quiet(args: list[str], timeout: int = 60):
    result = subprocess.run(args, capture_output=True, timeout=timeout,
                            creationflags=0x08000000 if os.name == 'nt' else 0)
    if result.returncode != 0:
        raise WatermarkError('无法读取或处理此媒体，请检查文件是否完整，以及框选位置是否有效。')
    return result


def inspect_media(path: Path, ffprobe: str) -> dict:
    if not path.is_file() or path.suffix.lower() not in ('.mp4', '.mkv', '.mov', '.webm', '.m4v', '.avi'):
        raise WatermarkError('请选择受支持的本地视频文件。')
    data = json.loads(run_quiet([ffprobe, '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)]).stdout)
    videos = [stream for stream in data.get('streams', []) if stream.get('codec_type') == 'video'
              and not stream.get('disposition', {}).get('attached_pic')]
    if not videos:
        raise WatermarkError('文件中没有可处理的视频轨道。')
    video = videos[0]
    if video.get('color_transfer') in ('smpte2084', 'arib-std-b67') or any(
            'dovi' in str(side.get('side_data_type', '')).lower() for side in video.get('side_data_list', [])):
        raise WatermarkError('水印处理首版支持 SDR 视频；HDR／杜比请先另行转换，避免颜色错误。')
    if video.get('sample_aspect_ratio', '1:1') not in ('1:1', 'N/A', '0:1'):
        raise WatermarkError('暂不支持非方形像素视频，请先转换为方形像素。')
    width, height = int(video.get('width') or 0), int(video.get('height') or 0)
    rotation = next((side.get('rotation', 0) for side in video.get('side_data_list', []) if 'rotation' in side), 0)
    if round(float(rotation)) % 180 == 90:
        width, height = height, width
    duration = float(data.get('format', {}).get('duration') or video.get('duration') or 0)
    if width < 32 or height < 32 or duration <= 0 or not math.isfinite(duration):
        raise WatermarkError('视频尺寸或时长无效，无法安全处理。')
    audios = [stream for stream in data.get('streams', []) if stream.get('codec_type') == 'audio']
    return {'width': width, 'height': height, 'duration': duration, 'hasAudio': bool(audios),
            'audioCodecs': [stream.get('codec_name') for stream in audios],
            'videoIndex': video['index']}


def validate_rect(rect: dict) -> None:
    values = [rect.get(key) for key in ('x', 'y', 'width', 'height')]
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in values):
        raise WatermarkError('框选坐标无效。')
    x, y, width, height = values
    if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1.000001 or y + height > 1.000001:
        raise WatermarkError('框选区域超出视频画面。')


def pixel_rect(rect: dict, width: int, height: int) -> tuple[int, int, int, int]:
    validate_rect(rect)
    x, y = int(rect['x'] * width) // 2 * 2, int(rect['y'] * height) // 2 * 2
    w = min(math.ceil(rect['width'] * width / 2) * 2, width // 2 * 2 - x)
    h = min(math.ceil(rect['height'] * height / 2) * 2, height // 2 * 2 - y)
    if w < 4 or h < 4:
        raise WatermarkError('区域太小，请至少框选 4 × 4 像素。')
    return x, y, w, h


def build_filter(regions: list[dict], crop: dict | None, width: int, height: int, video_index: int = 0):
    if not isinstance(regions, list) or len(regions) > 8 or not regions and crop is None:
        raise WatermarkError('请设置 1 至 8 个水印区域，或框选裁剪保留画面。')
    graph = [f'[0:{video_index}]setsar=1,format=yuv420p[v0]']
    for index, region in enumerate(regions):
        x, y, w, h = pixel_rect(region, width, height)
        method = region.get('method')
        if method not in ('cover', 'blur'):
            raise WatermarkError('不支持的处理方式。')
        graph.append(f'[v{index}]split[b{index}][p{index}]')
        if method == 'blur':
            radius = max(1, min(16, min(w, h) // 4))
            graph.append(f'[p{index}]crop={w}:{h}:{x}:{y},boxblur={radius}:2[patch{index}]')
        else:
            source = region.get('source')
            if source is None:
                candidates = [(x, y + h), (x, y - h), (x + w, y), (x - w, y)]
                source_pixel = next(((sx, sy) for sx, sy in candidates
                                     if sx >= 0 and sy >= 0 and sx + w <= width and sy + h <= height), None)
                if source_pixel is None:
                    raise WatermarkError('附近没有足够的参考背景，请缩小区域、手动选择参考区或改用模糊。')
                sx, sy = source_pixel
            else:
                sx, sy, _, _ = pixel_rect({**region, 'x': source.get('x'), 'y': source.get('y')}, width, height)
                if sx + w > width or sy + h > height:
                    raise WatermarkError('背景参考区域超出画面。')
            if max(x, sx) < min(x + w, sx + w) and max(y, sy) < min(y + h, sy + h):
                raise WatermarkError('背景参考区不能与自身水印区重叠，请选择干净背景。')
            feather = min(6, max(1, min(w, h) // 8))
            alpha = f'255*min(1,min(min(X,W-1-X),min(Y,H-1-Y))/{feather})'
            graph.append(f"[p{index}]crop={w}:{h}:{sx}:{sy},format=yuva444p,"
                         f"geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='{alpha}'[patch{index}]")
        graph.append(f'[b{index}][patch{index}]overlay={x}:{y}:format=auto[v{index + 1}]')
    if crop:
        x, y, output_width, output_height = pixel_rect(crop, width, height)
        if min(output_width, output_height) < 32:
            raise WatermarkError('裁剪后画面不能小于 32 × 32 像素。')
    else:
        x, y, output_width, output_height = 0, 0, width // 2 * 2, height // 2 * 2
    graph.append(f'[v{len(regions)}]crop={output_width}:{output_height}:{x}:{y},format=yuv420p[out]')
    return ';'.join(graph), output_width, output_height


def extract_frame(command: dict, ffmpeg: str, ffprobe: str) -> dict:
    source = Path(command['inputPath']).resolve()
    metadata = inspect_media(source, ffprobe)
    timestamp = float(command.get('timestamp', 0))
    if not math.isfinite(timestamp) or not 0 <= timestamp < metadata['duration']:
        raise WatermarkError('预览时间超出视频时长。')
    output = Path(command['framePath'])
    output.parent.mkdir(parents=True, exist_ok=True)
    run_quiet([ffmpeg, '-v', 'error', '-nostdin', '-ss', str(timestamp), '-i', str(source),
               '-map', f"0:{metadata['videoIndex']}", '-frames:v', '1', '-vf', "scale='min(1280,iw)':-1,setsar=1",
               '-y', str(output)])
    return metadata


def process_video(command: dict, ffmpeg: str, ffprobe: str, emit) -> None:
    source = Path(command['inputPath']).resolve()
    metadata = inspect_media(source, ffprobe)
    regions, crop = command.get('regions'), command.get('crop')
    graph, output_width, output_height = build_filter(regions, crop, metadata['width'], metadata['height'], metadata['videoIndex'])
    preview = command.get('preview') is True
    timestamp = float(command.get('timestamp', 0)) if preview else 0
    if not math.isfinite(timestamp) or not 0 <= timestamp < metadata['duration']:
        raise WatermarkError('预览时间超出视频时长。')
    duration = min(5, metadata['duration'] - timestamp) if preview else metadata['duration']
    output = Path(command['outputPath']).resolve()
    if output == source or output.exists():
        raise WatermarkError('输出文件必须为新的副本，不能覆盖原视频或现有文件。')
    output.parent.mkdir(parents=True, exist_ok=True)
    if shutil.disk_usage(output.parent).free < max(source.stat().st_size * (0.2 if preview else 2), 100 * 1024 * 1024):
        raise WatermarkError('磁盘空间不足，请更换输出目录。')
    task_id = str(command['taskId'])
    import uuid
    try:
        uuid.UUID(task_id)
    except ValueError:
        raise WatermarkError('任务标识无效。') from None
    partial = output.with_name(f'.vido-{task_id}.processing.mp4')
    if partial.exists():
        raise WatermarkError('处理临时文件已存在，请创建新任务。')
    args = [ffmpeg, '-hide_banner', '-loglevel', 'error', '-nostdin']
    if preview:
        args += ['-ss', str(timestamp)]
    args += ['-i', str(source), '-filter_complex', graph, '-map', '[out]', '-map', '0:a?',
             '-map_metadata', '-1', '-c:v', 'libx264', '-crf', '18', '-preset', 'fast' if preview else 'medium',
             '-pix_fmt', 'yuv420p']
    for index, codec in enumerate(metadata['audioCodecs']):
        if codec in ('aac', 'mp3'):
            args += [f'-c:a:{index}', 'copy']
        else:
            args += [f'-c:a:{index}', 'aac', f'-b:a:{index}', '192k']
    if preview:
        args += ['-t', str(duration)]
    args += ['-movflags', '+faststart', '-progress', 'pipe:1', '-stats_period', '0.3', '-n', str(partial)]
    emit('stage', stage='processing', message='生成短片段预览' if preview else '正在处理水印并重新编码副本')
    process = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, encoding='utf-8',
                               creationflags=0x08000000 if os.name == 'nt' else 0)
    last = 0.0
    try:
        for line in process.stdout:
            if line.startswith('out_time_us=') and time.monotonic() - last >= 0.25:
                last = time.monotonic()
                try:
                    seconds = max(0, int(line.strip().split('=', 1)[1]) / 1_000_000)
                except ValueError:
                    continue
                emit('progress', percent=min(99, seconds / duration * 100),
                     message=f'已处理 {seconds:.1f} / {duration:.1f} 秒 · 视频重新编码')
        if process.wait() != 0:
            raise WatermarkError('水印处理失败，请检查框选范围和背景参考位置。原视频未修改。')
        emit('stage', stage='verifying', message='校验处理副本的视频、音轨和时长')
        actual = inspect_media(partial, ffprobe)
        if actual['width'] != output_width or actual['height'] != output_height or actual['hasAudio'] != metadata['hasAudio']:
            raise WatermarkError('处理结果尺寸或音轨不符，未生成正式副本。')
        if abs(actual['duration'] - duration) > max(0.5, duration * 0.01):
            raise WatermarkError('处理副本时长异常，未标记成功。')
        partial.rename(output)
        emit('completed', filePath=str(output), message='短片段预览已生成' if preview else '水印处理副本已保存，原文件保留')
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=10)
        process.stdout.close()
        if partial.exists():
            partial.unlink()
