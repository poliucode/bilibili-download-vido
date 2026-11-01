# Windows MVP 验证记录

日期：2026-11-01。

## v0.2.0 增量

新增本地水印处理页面、下载任务入口、多区域背景覆盖／局部模糊、参考背景选择、裁剪、可播放短片段预览与完整 MP4 副本导出。详细操作和边界见 [水印处理说明](watermark-processing.md)。

`npm test` 当前覆盖 6 项 TypeScript 与 18 项 Python 测试；水印的真实 FFmpeg 测试包含预期像素变化、音轨保留、混合音轨按编码分别处理、裁剪、旋转、预览时长及源文件不变。`npm run test:watermark` 已通过实际桌面框选、参考区选择、预览播放、Range／无效令牌、导出、设置变化失效和取消检查。

0.2.0 的完整目录版也已通过水印桌面流程；应用子进程 PATH 不含系统 Python／ffmpeg。用户授权的 B 站样本重新下载成功，并能从已完成任务打开水印编辑器。测试期间曾有一次真实下载返回通用引擎错误，随后独立下载验证和打包客户端复测均成功，未定位该次失败的根因。

当前产物位于 `release/0.2.0/`，使用独立版本目录以避免覆盖正在使用的旧客户端。安装器未签名，未执行系统安装／卸载。

以下 MVP 样本与 0.1.0 的打包记录作为历史保留；当前功能与安装包以 0.2.0 为准。

## 已实现

- Electron + React + TypeScript 窗口，包含新建下载、任务和设置页。
- 解析普通 BV、完整链接、明确分 P；短链接包含目标域验证。
- 展示真实视频／音频轨道，支持手动选择、最高可用与兼容优先。
- 单任务下载、取消、阶段进度、MP4／MKV 无重编码封装、媒体校验和文件定位。
- 用户主动导入 Netscape cookies.txt，验证 B 站账号，Electron safeStorage 加密保存。
- Python 的 CookieJar 仅驻留内存，不创建明文 Cookie 临时文件。
- JSONL 独立 worker；Windows Job Object 在进程终止时清理媒体子进程。
- PyInstaller onedir 引擎、独立 ffmpeg／ffprobe 资源及 Windows 打包脚本。

## 真实样本

用户提供并授权验收的视频：[BV197x16UEKn](https://www.bilibili.com/video/BV197x16UEKn)。本次使用未登录会话，没有读取或导入用户真实 Cookie。

实际解析返回 1080P 等档位以及 AVC／HEVC／AV1 和独立音轨。已完成 Python 直连验证和 Electron 界面操作验证，选择：

- 视频：1920 × 1080，30 fps，H.264。
- 音频：AAC，平台返回约 167 kbps 的轨道。
- 容器：MP4；streamcopy 合并。
- 成品：ffprobe 检测视频为 h264、音频为 aac，时长约 73.119773 秒。

该结果只证明此视频在本次测试环境中的结果，不证明所有未登录视频均可取得 1080P。

Python 样本报告与成品位于 `.test-output/sample-verification.json` 和 `.test-output/downloads/`；客户端端到端成品位于 `.test-output/desktop-downloads/`，后续打包验收使用 `.test-output/中文 download 输出/` 检查中文和空格路径。

## 自动化检查

`npm test` 已通过 4 项 TypeScript 和 10 项 Python 测试，覆盖：输入限制、轨道完整性参数、兼容策略、Cookie 域过滤、内存 CookieJar、脱敏错误、Windows 文件名、分 P 路由、格式变化不降级、真实媒体封装校验以及杀死 worker 后子进程退出。

`npm run build` 已通过 TypeScript 类型检查和主进程／preload／renderer 生产构建。

桌面冒烟测试真正启动 Electron，检查 renderer 无 `require`、桥接可用、引擎就绪、非法链接反馈、设置页及用户样本从解析到完成的流程。截图保存在 `.test-output/desktop-*.png`。

开发服务器模式与生产构建模式均已通过桌面冒烟检查。

`npm audit --omit=dev --registry=https://registry.npmjs.org` 返回生产 npm 依赖 0 项已知漏洞；这不代表 Electron、Python 和完整安装包经过了独立安全审计。

## Windows 打包验收

`npm run package:win` 已成功生成：

- `release/win-unpacked/Bilibili Vido.exe`：需要保留整个同级目录，可直接双击。
- `release/Bilibili Vido Setup 0.1.0.exe`：NSIS 安装包，约 259 MiB。

已对完整目录版执行真实桌面下载测试。测试通过目录联接从含中文与空格的路径启动，将输出目录设为 `.test-output/中文 download 输出/`；同时将应用子进程 PATH 限制为 Windows 系统目录，故意提供不可用的开发 Python／工具路径。结果仍由包内 Python 引擎和媒体工具完成同一用户样本的 1080P H.264 + AAC MP4 下载与校验。

已逐字节比对发布包 ASAR 内的 main、preload 和 renderer HTML 与最终生产构建，确认产物匹配。没有执行安装器的系统安装／卸载，也没有在独立干净虚拟机上验证。

## 已知边界

- Cookie 域过滤、内存传递与加密接口已实现，但没有真实登录 Cookie，因此会员权限视频和真实登录成功／过期场景尚未端到端验收。
- 当前真实样本只有单 P；多 P 路由通过模拟元数据测试，未使用真实多 P 视频下载验收。短链接同样需要真实样本补充。
- 未专项验证 4K／HDR／杜比／Hi-Res 音轨，不对这些格式宣称全部元数据必然保留。
- 任务仅在内存中保留，暂停恢复、持久队列和批量分 P 属于后续阶段。
- MVP 关闭窗口即退出，活动任务会提示。托盘常驻属于后续增强。
- 当前只在本机 Windows 11 验证，不等于通过独立干净机器、所有 Windows 版本或其他系统验收。
- 安装包未代码签名。本机已安装的媒体工具构建许可随包收集，公开分发前仍需核对该构建的对应源代码等许可义务。
