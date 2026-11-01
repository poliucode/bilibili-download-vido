# Third-party components

This local build includes Electron (MIT and Chromium third-party notices), React / React DOM (MIT),
Lucide icons (ISC), Python (PSF license), yt-dlp (Unlicense), PyInstaller (GPL with bootloader exception),
and FFmpeg / FFprobe under the license of the selected FFmpeg build. Additional Python dependencies
are collected by PyInstaller. Their installed metadata and license files are retained where available.

Electron's LICENSE and LICENSES.chromium.html are included alongside the application executable.
Python's license and collected package notices are included in the engine resources.
The FFmpeg LICENSE from the build used to produce this package is included separately.

Upstream sources:

- https://github.com/electron/electron
- https://github.com/facebook/react
- https://github.com/lucide-icons/lucide
- https://www.python.org/downloads/source/
- https://github.com/yt-dlp/yt-dlp
- https://github.com/pyinstaller/pyinstaller
- https://ffmpeg.org/download.html

The current packaging script uses the FFmpeg binaries available on the build machine.
This is a local MVP build. Public redistribution requires checking the exact binary configuration,
all applicable notices, and corresponding-source obligations for that build; this file alone does
not satisfy those obligations. Record `ffmpeg -version` when preparing a distributable release.
