# Bilibili Download Vido

基于 **Electron + React + TypeScript + Python** 的 Windows 桌面下载工具，已实现首版 MVP。

**v0.2.0 新增本地水印处理**：多区域框选、背景参考覆盖与边缘融合、局部模糊、画面裁剪、最多 5 秒预览与完整副本导出。

**推荐路线：Windows 客户端优先，Chrome／Edge 插件作为后续一键下载入口。**

Python 使用 yt-dlp 下载，ffmpeg／ffprobe 负责无重编码合并与成品校验。

目标是保存当前账号有权获取的高画质播放流，合并时不重新编码。这里的“原画质”指平台提供的播放版本，不承诺取得 UP 主上传前的源文件。

- [完整设计分析](docs/design-analysis.md)：产品边界、五种实现形式比较、技术选型、架构、登录与画质策略。
- [实施与验收计划](docs/implementation-plan.md)：分阶段落地、验证样本、完成标准。
- [MVP 验证记录](docs/mvp-verification.md)：实际测试范围与尚未验证的能力。
- [水印处理说明](docs/watermark-processing.md)：框选、背景参考、预览和导出方式。

## 使用方式

打包完成后，双击 `release/0.2.0/win-unpacked/Bilibili Vido.exe` 直接运行。必须保留整个 `win-unpacked` 目录，不能单独拷走 EXE。发布产物按版本保存在 `release/<版本>/`，避免覆盖正在使用的旧客户端。

当前版本安装包为 `release/0.2.0/Bilibili Vido Setup 0.2.0.exe`。若旧客户端仍在运行，请先在旧窗口退出，再启动新版。

1. 粘贴 BV 号、普通视频链接或 b23.tv 短链接，点击“解析视频”。
2. 选择当前分 P、视频轨道与音轨。最高可用画质和兼容优先都会显示实际选中规格。
3. 选择 MP4／MKV 容器和输出目录，点击“开始下载”。
4. 完成后点击文件夹图标定位文件；进行中的任务可以取消。
5. 如需要登录权限，在“设置与账号”主动导入 **Netscape 格式的 cookies.txt**；应用会验证并加密保存 B 站会话。不会自动读取浏览器 Cookie。

未登录时返回的画质取决于视频及平台响应，不保证特定档位。高级动态范围轨道会保留平台编码，但 HDR／杜比元数据尚未专项验收。

### 水印处理

打开左侧“水印处理”，选择本地视频；也可点击已完成任务旁的橡皮图标进入。拖动框选水印区域，按需选择背景覆盖或局部模糊，点击“生成 5 秒预览”。播放检查效果后，使用“另存完整处理副本”。调整设置后需重新预览。

水印与 B 站标识需要手动框选，暂不自动识别或追踪。背景覆盖可以手选干净的参考位置；裁剪模式应框选要保留的画面。处理副本会重新编码为 H.264 MP4，下载原文件保持不变。

## 开发运行

需要 Node.js 22.12+（本次使用 24）、Python 3.10+（本次使用 3.13）和可运行的 ffmpeg／ffprobe。

```powershell
npm ci
npm run setup
python -m pip install -r engine/requirements.txt
npm run dev
```

`npm run setup` 显式安装与锁文件匹配的 Electron 二进制，便于处理限制依赖安装脚本的 npm 环境。

开发引擎优先使用项目 `.venv/Scripts/python.exe`，否则使用 PATH 的 Python；可通过 `VIDO_PYTHON` 指定解释器，通过 `VIDO_TOOLS` 指定媒体工具目录。开发模式不能仅在普通浏览器打开 React 页面：它需要 Electron 的 preload 桥接。

## 构建与检查

```powershell
npm test
npm run build
npm run test:desktop
npm run test:watermark
npm run package:win
```

- `npm test`：TypeScript 输入／格式策略测试，Python Cookie 域过滤、分 P、格式变化、媒体验证与 Windows 进程树测试。
- `npm run test:desktop`：真正启动 Electron，检查隔离、界面、错误反馈与设置页。
- `npm run test:watermark`：生成带模拟角标的本地视频，实际验证框选、多区域、背景参考、可播放预览、导出、裁剪及取消。
- `npm run package:dir`：生成可运行的完整目录；`package:win` 另生成 NSIS 安装器。
- 打包依赖构建机器上完整 ffmpeg 发行目录中的 `LICENSE`。本次为本机 MVP 构建，第三方说明随包提供。

使用明确授权的真实样本做完整界面验收：

```powershell
$env:VIDO_SAMPLE_URL = 'https://www.bilibili.com/video/你的BV号'
npm run test:desktop
```

该命令会实际下载视频到 `.test-output/中文 download 输出`，同时检查中文和空格路径；测试配置与账号数据使用独立的 `.test-output/desktop-profile`，不改动正常用户配置。

## 本地数据与限制

正常配置与加密会话位于 Electron 的 `userData` 目录（Windows 通常为 `%APPDATA%/bilibili-download-vido`）。会话在 Python 中仅使用内存 CookieJar，不写明文 Cookie 临时文件。清除会话只删除应用保存的数据，不删除用户原始导入文件。

MVP 每次只执行一个下载；任务列表仅保留本次启动的最近 30 项。关闭窗口即退出，正在执行操作时会提示；退出会中止任务，没有托盘常驻。取消后未完成媒体保留在目标目录 `.vido-partial`，首版不提供恢复按钮，可以在退出应用后自行清理。

水印处理与下载共用单任务执行限制。帧图和短片段保存在 `userData/watermark-cache`，下次启动会清理该临时目录；不要将自己的视频或正式成品存入此目录。完整导出副本保存在另存对话框中选择的位置，不会因清理预览缓存被删除。

首版不提供持久队列、断点恢复、二维码登录、自动更新、订阅、直播或浏览器插件。多 P 当前逐个选择下载，不支持一键批量勾选。应用未做代码签名，也未在独立干净 Windows 虚拟机上验收。

## 代码结构

```text
desktop/src/main/       Electron 主进程、设置、凭据与任务
desktop/src/preload/    最小权限 IPC 桥接
desktop/src/renderer/   React 界面与样式
desktop/src/shared/     类型、输入验证与格式策略
engine/                Python JSONL 引擎与测试
packaging/             Windows 引擎打包和第三方声明
scripts/               桌面冒烟测试与真实样本验证
docs/                  设计、实施计划与验证记录
```
