import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import os
from unittest.mock import patch

WORKER = Path(__file__).resolve().parents[1] / 'worker.py'
sys.path.insert(0, str(WORKER.parent))
spec = importlib.util.spec_from_file_location('worker', WORKER)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerTests(unittest.TestCase):
    def test_cookie_scope_does_not_include_lookalike_or_other_sites(self):
        cookies = '# Netscape HTTP Cookie File\n' + '\n'.join([
            '.bilibili.com\tTRUE\t/\tTRUE\t2147483647\tSESSDATA\tprivate-test-value',
            '.bilibili.com.evil.test\tTRUE\t/\tTRUE\t2147483647\tSESSDATA\tevil',
            '.example.org\tTRUE\t/\tTRUE\t2147483647\tother\tsecret'
        ])
        filtered = worker.filter_cookies(cookies)
        self.assertIn('private-test-value', filtered)
        self.assertNotIn('evil', filtered)
        self.assertNotIn('example.org', filtered)
        provider = worker.Provider(filtered)
        self.assertEqual(len(provider.jar), 1)
        self.assertIsNone(provider.jar.filename)
        with provider.downloader() as downloader:
            self.assertEqual(len(downloader.cookiejar), 1)
            self.assertIsNone(downloader.cookiejar.filename)

    def test_normalization_rejects_external_and_preserves_parts(self):
        self.assertEqual(worker.normalize_url('BV197x16UEKn'),
                         'https://www.bilibili.com/video/BV197x16UEKn?p=1')
        for value in ('https://example.org/a', 'http://bilibili.com/video/BV197x16UEKn',
                      'https://bilibili.com/video/BV197x16UEKn?p=0'):
            with self.assertRaises(worker.UserError):
                worker.normalize_url(value)

    def test_format_key_ignores_expiring_url_but_detects_codec_change(self):
        item = {'format_id': '80', 'vcodec': 'avc1', 'acodec': 'none', 'height': 1080, 'url': 'old'}
        original = worker.format_option(item)['key']
        self.assertEqual(original, worker.format_option({**item, 'url': 'new'})['key'])
        self.assertNotEqual(original, worker.format_option({**item, 'vcodec': 'hvc1'})['key'])

    def test_multi_part_probe_uses_explicit_part_and_preserves_cid(self):
        provider = worker.Provider(None)
        metadata = {'bvid': 'BV197x16UEKn', 'title': 'sample', 'pages': [
            {'page': 1, 'cid': 111, 'part': 'first'}, {'page': 2, 'cid': 222, 'part': 'second'}
        ]}
        info = {'duration': 10, 'formats': [
            {'format_id': '80', 'vcodec': 'avc1', 'acodec': 'none', 'height': 1080}
        ]}
        with patch.object(provider, 'api', return_value=metadata), patch.object(provider, 'extract', return_value=info) as extract:
            result = provider.probe('BV197x16UEKn', 2)
            self.assertEqual(result['currentPage'], 2)
            self.assertEqual(result['parts'][1]['cid'], '222')
            extract.assert_called_once_with('https://www.bilibili.com/video/BV197x16UEKn?p=2')

    def test_expired_format_key_stops_instead_of_downgrading(self):
        provider = worker.Provider(None)
        with patch.object(provider, 'resolve', return_value=('https://www.bilibili.com/video/BV197x16UEKn?p=1', {}, 1)), \
                patch.object(provider, 'extract', return_value={'formats': []}), \
                patch.object(worker, 'attach_windows_job'):
            with self.assertRaisesRegex(worker.UserError, '没有自动降低画质'):
                worker.download(provider, {'url': 'BV197x16UEKn', 'video': {'key': 'old'}, 'page': 1})

    def test_errors_do_not_expose_signed_urls_or_cookie_values(self):
        error = Exception('HTTP Error 403 https://cdn.test/private?sign=secret Cookie=private')
        sanitized = worker.safe_error(error)
        self.assertNotIn('secret', sanitized)
        self.assertNotIn('cdn.test', sanitized)

    def test_windows_filename_sanitization(self):
        self.assertEqual(worker.safe_filename('CON'), 'video_CON')
        self.assertEqual(worker.safe_filename('a/b:c?'), 'a_b_c_')

    def test_jsonl_process_reports_invalid_input_without_traceback(self):
        result = subprocess.run([sys.executable, str(WORKER)],
                                input=json.dumps({'action': 'probe', 'url': 'https://evil.test', 'requestId': 'test'}),
                                text=True, encoding='utf-8', capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        event = json.loads(result.stdout)
        self.assertEqual(event['type'], 'error')
        self.assertEqual(event['requestId'], 'test')
        self.assertNotIn('Traceback', result.stderr)

    def test_real_streamcopy_keeps_tracks_and_rejects_wrong_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'source.mp4'
            path = Path(directory) / 'test.mp4'
            subprocess.run([
                worker.find_tool('ffmpeg', None), '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
                '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
                '-c:a', 'aac', str(source)
            ], check=True, capture_output=True, timeout=30)
            subprocess.run([worker.find_tool('ffmpeg', None), '-v', 'error', '-i', str(source),
                            '-map', '0', '-c', 'copy', str(path)], check=True, capture_output=True, timeout=30)
            selected = {'kind': 'video', 'codec': 'avc1', 'width': 320, 'height': 240, 'fps': 30}
            self.assertEqual(worker.verify_media(path, selected, {'id': 'audio'}, 1, None)['height'], 240)
            with self.assertRaises(worker.UserError):
                worker.verify_media(path, {**selected, 'height': 1080}, {'id': 'audio'}, 1, None)

    @unittest.skipUnless(os.name == 'nt', 'Windows Job Object only')
    def test_worker_job_terminates_descendant_when_worker_is_killed(self):
        import ctypes
        from ctypes import wintypes
        code = (
            f'import sys; sys.path.insert(0, {str(WORKER.parent)!r}); '
            'import worker, subprocess; worker.attach_windows_job(); '
            'child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(120)"]); '
            'print(child.pid, flush=True); import time; time.sleep(120)'
        )
        parent = subprocess.Popen([sys.executable, '-u', '-c', code], stdout=subprocess.PIPE, text=True)
        kernel = ctypes.WinDLL('kernel32')
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = None
        try:
            child_pid = int(parent.stdout.readline().strip())
            handle = kernel.OpenProcess(0x00100000, False, child_pid)
            self.assertTrue(handle)
            parent.kill()
            parent.wait(timeout=10)
            self.assertEqual(kernel.WaitForSingleObject(handle, 10000), 0)
        finally:
            if parent.poll() is None:
                parent.kill()
                parent.wait(timeout=10)
            parent.stdout.close()
            if handle:
                kernel.CloseHandle(handle)


if __name__ == '__main__':
    unittest.main()
