import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from watermark import WatermarkError, build_filter, inspect_media, process_video, extract_frame
from worker import find_tool


class WatermarkTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.root = Path(cls.directory.name)
        cls.source = cls.root / '原始 source.mp4'
        cls.ffmpeg = find_tool('ffmpeg', None)
        cls.ffprobe = find_tool('ffprobe', None)
        subprocess.run([
            cls.ffmpeg, '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24',
            '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6',
            '-vf', 'drawbox=x=0:y=0:w=80:h=240:color=0x30465e:t=fill,drawbox=x=10:y=10:w=50:h=20:color=white:t=fill',
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', str(cls.source)
        ], check=True, capture_output=True, timeout=30)
        cls.original_hash = hashlib.sha256(cls.source.read_bytes()).hexdigest()

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def process(self, name, regions, crop=None, preview=False):
        target = self.root / f'{name}.mp4'
        events = []
        process_video({
            'inputPath': str(self.source), 'outputPath': str(target), 'preview': preview,
            'timestamp': 0.5, 'regions': regions, 'crop': crop, 'taskId': str(uuid.uuid4())
        }, self.ffmpeg, self.ffprobe, lambda event, **payload: events.append((event, payload)))
        self.assertEqual(events[-1][0], 'completed')
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), self.original_hash)
        self.assertFalse(list(self.root.glob('.vido-*.processing.mp4')))
        return target

    def test_frame_extract_and_dimensions(self):
        frame = self.root / 'frame.png'
        info = extract_frame({'inputPath': str(self.source), 'framePath': str(frame), 'timestamp': 2}, self.ffmpeg, self.ffprobe)
        self.assertEqual((info['width'], info['height']), (320, 240))
        self.assertTrue(frame.read_bytes().startswith(b'\x89PNG'))

    def test_cover_blur_and_preview_duration_preserve_audio(self):
        regions = [
            {'x': 6 / 320, 'y': 6 / 240, 'width': 60 / 320, 'height': 30 / 240, 'method': 'cover'},
            {'x': 0.8, 'y': 0.8, 'width': 0.18, 'height': 0.18, 'method': 'blur'}
        ]
        target = self.process('cover-preview', regions, preview=True)
        info = inspect_media(target, self.ffprobe)
        self.assertEqual((info['width'], info['height']), (320, 240))
        self.assertTrue(info['hasAudio'])
        self.assertAlmostEqual(info['duration'], 5, delta=0.15)
        def pixel(path):
            return subprocess.run([self.ffmpeg, '-v', 'error', '-ss', '1', '-i', str(path),
                                   '-vf', 'crop=2:2:30:20,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'],
                                  check=True, capture_output=True, timeout=10).stdout
        self.assertGreater(pixel(self.source)[0], 220)
        self.assertLess(pixel(target)[0], 100)

    def test_crop_exports_requested_even_dimensions(self):
        target = self.process('crop-output', [], {'x': 0.25, 'y': 0, 'width': 0.75, 'height': 1})
        info = inspect_media(target, self.ffprobe)
        self.assertEqual((info['width'], info['height']), (240, 240))
        self.assertTrue(info['hasAudio'])

    def test_invalid_regions_and_overlap_rejected_before_export(self):
        for rect in [
            {'x': -0.1, 'y': 0, 'width': 0.2, 'height': 0.2, 'method': 'blur'},
            {'x': 0, 'y': 0, 'width': float('nan'), 'height': 0.2, 'method': 'blur'},
            {'x': 0, 'y': 0, 'width': 1, 'height': 1, 'method': 'cover'},
            {'x': 0.1, 'y': 0.1, 'width': 0.2, 'height': 0.2, 'method': 'cover', 'source': {'x': 0.1, 'y': 0.1}}
        ]:
            with self.assertRaises(WatermarkError):
                build_filter([rect], None, 320, 240)

    def test_source_and_existing_output_are_never_overwritten(self):
        with self.assertRaisesRegex(WatermarkError, '不能覆盖'):
            process_video({'inputPath': str(self.source), 'outputPath': str(self.source),
                           'regions': [], 'crop': {'x': 0, 'y': 0, 'width': 1, 'height': 1}},
                          self.ffmpeg, self.ffprobe, lambda *_args, **_kwargs: None)

    def test_edge_blur_and_manual_background_source(self):
        regions = [
            {'x': 0, 'y': 0, 'width': 0.2, 'height': 0.15, 'method': 'cover', 'source': {'x': 0, 'y': 0.5}},
            {'x': 0.9, 'y': 0.9, 'width': 0.1, 'height': 0.1, 'method': 'blur'}
        ]
        target = self.process('edge-output', regions)
        self.assertTrue(target.is_file())

    def test_rotation_uses_display_coordinates(self):
        rotated = self.root / 'rotated.mp4'
        subprocess.run([self.ffmpeg, '-v', 'error', '-display_rotation:v:0', '90', '-i', str(self.source),
                        '-c', 'copy', str(rotated)], check=True, capture_output=True, timeout=15)
        info = inspect_media(rotated, self.ffprobe)
        self.assertEqual((info['width'], info['height']), (240, 320))
        target = self.root / 'rotated-output.mp4'
        process_video({'inputPath': str(rotated), 'outputPath': str(target), 'regions': [],
                       'crop': {'x': 0, 'y': 0, 'width': 1, 'height': 1}, 'taskId': str(uuid.uuid4())},
                      self.ffmpeg, self.ffprobe, lambda *_args, **_kwargs: None)
        result = inspect_media(target, self.ffprobe)
        self.assertEqual((result['width'], result['height']), (240, 320))

    def test_mixed_audio_copies_aac_while_converting_flac(self):
        mixed = self.root / 'mixed-audio.mkv'
        subprocess.run([self.ffmpeg, '-v', 'error', '-i', str(self.source), '-f', 'lavfi', '-i',
                        'sine=frequency=880', '-t', '6', '-map', '0:v', '-map', '0:a', '-map', '1:a',
                        '-c:v', 'copy', '-c:a:0', 'copy', '-c:a:1', 'flac', str(mixed)],
                       check=True, capture_output=True, timeout=15)
        target = self.root / 'mixed-output.mp4'
        process_video({'inputPath': str(mixed), 'outputPath': str(target), 'regions': [],
                       'crop': {'x': 0, 'y': 0, 'width': 1, 'height': 1}, 'taskId': str(uuid.uuid4())},
                      self.ffmpeg, self.ffprobe, lambda *_args, **_kwargs: None)
        self.assertEqual(inspect_media(target, self.ffprobe)['audioCodecs'], ['aac', 'aac'])
        def audio_hash(path):
            return subprocess.run([self.ffmpeg, '-v', 'error', '-i', str(path), '-map', '0:a:0',
                                   '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
                                  check=True, capture_output=True, timeout=15).stdout
        self.assertEqual(audio_hash(mixed), audio_hash(target))


if __name__ == '__main__':
    unittest.main()
