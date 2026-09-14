# dsh-plugin-ambient-video · 氛围背景视频

[English](README.en.md) | 简体中文

> 给 DeepSeek Harness 的 Web GUI 加一层**铺满全屏的毛玻璃氛围背景视频**：支持 B 站 / YouTube / **本地高规格视频** / **B 站直播 + Twitch** / **Jellyfin 媒体库**；本地视频与直播走**原生 `<video>` 解码**（MKV 自动转封装，HEVC 交 Jellyfin 转码），VOD 走 iframe 嵌入 + 声卡循环；还能**读取 B 站 Cookie → 拉取收藏 → AI 推荐卡片**；透明度 / 亮度 / 毛玻璃强度全部可调，设置自动保存。

本仓库是一个 DSH web profile 的外插件包：host 半区注册 `/playurl /playstop /playsearch /playsearchw /playlocal /playlive /playask` 命令与 `/ambient-*` 系列路由（本地视频 Range 流、ffprobe 探测、直播取流、Jellyfin API、B 站收藏 wbi 签名、Cookie 读取、AI 端点、声卡检测、代理配置）；浏览器半区渲染 shell 浮层背景层与设置页，本地/直播/Jellyfin 用原生 `<video>` + hls.js/flv.js 播放，VOD 用 iframe 嵌入。

## 演示

- **v1.0.0 Release**：https://github.com/Gitlandfor/dsh-plugin-ambient-video/releases/tag/v1.0.0
- **`demo.mp4` —— 演示视频**（效果展示）：点上方 Release 链接 → Assets → `demo.mp4` 预览/下载

## 功能

- **全屏毛玻璃背景**：B 站 / YouTube / 任意视频链接，iframe 放大裁剪掉播放器 UI，只留画面；透明度（50% 默认）、亮度（120% 默认）、毛玻璃强度（6px 默认）实时可调。
- **单曲循环（声卡状态检测）**：host 用 `pactl` 监听系统音频输出——B 站视频播完（Chrome 音频流消失）→ 客户端自动重挂重播（延迟约 2.5–3s）；重挂后仍无声自动重试，最多 2 次。**静音播放没有音频信号，不循环**。YouTube 走原生 `loop=1&playlist=`，无缝循环。
- **命令**：
  - `/playurl <任意链接>` — 播放 / 切换背景视频（B 站 / 油管专用嵌入，其它链接直嵌 iframe）
  - `/playstop` — 暂停（再输入链接即从头播放）
  - `/playsearch <关键词>` — 国内搜索（B 站优先：官方 API → AnySearch → Bing）
  - `/playsearchw <关键词>` — 外网搜索（YouTube 优先，走代理）
  - `/playlocal <路径>` — 播放本地视频（MP4/WebM 直播，MKV 自动转封装，HEVC 提示 Jellyfin）
  - `/playlive <房间号|链接|twitch:频道>` — 播放直播（B 站原生流 / Twitch 嵌入）
  - `/playask <描述>` — AI 从 B 站收藏里推荐并出卡片（AI 不可达时随机兜底）
- **设置页**：背景透明度 / 背景亮度 / 毛玻璃强度 / 显示弹幕（仅 B 站）/ 静音播放 / 单曲循环开关 / **搜索代理**（可配，留空=直连），全部自动保存（浏览器 localStorage）。
- **搜索容错**：B 站官方 API 有风控（间歇 412），自动重试并多源兜底；整体 5 秒硬超时，超时明确报错。
- **🆕 本地视频（原生解码）**：`/playlocal <路径>` 或设置页文件浏览器直接选——Host 用 ffprobe 探测编码/分辨率/时长，MP4/WebM 直接原生 `<video>` 播放，MKV/AVI/FLV 自动 `ffmpeg -c copy` 转封装成 MP4（秒级不重编码），HEVC 等浏览器解不了的编码提示走 Jellyfin。支持 HTTP Range（可拖动进度条）。
- **🆕 直播（B 站 + Twitch）**：`/playlive <房间号|链接|twitch:频道>`——B 站走 `getRoomPlayInfo` 取 FLV/HLS 原生流（无需登录），Twitch 走官方 `player.twitch.tv` 嵌入。裸房间号也能在 `/playurl` 里直接用。
- **🆕 Jellyfin 媒体库**：设置页填服务器地址 + 账号 → 连接后列出媒体库 → 卡片网格（封面/标题/年份）→ 点卡片原生 HLS 循环播放。服务端自动适配转码，HEVC/4K/HDR 也能解。图片走 Host 代理（不泄露 token 到浏览器）。
- **🆕 B 站收藏推荐**：设置页点「从 Firefox 读 / 从 Chrome 读」自动提取 B 站登录 Cookie（Firefox 明文直读、Chrome v10 AES-GCM 解密、亦可粘贴），加载收藏夹列表 → 选收藏夹 → 卡片网格展示（封面/标题/UP主/时长），点卡片直接播放。
- **🆕 AI 推荐（`/playask`）**：`/playask <想要的调性>`——从你的 B 站收藏里让 **AI 选片**（后端在设置页开放选择：本地 vLLM / 任意 OpenAI 兼容端点 / 关闭走随机兜底），结果以**卡片**呈现（含推荐理由），点卡片即播。

## 环境要求

- DSH web profile（持久插件机制）。
- **dsh-free-search**（peer 依赖）——提供 `web.search` / `web.fetch` 搜索与抓取服务；profile bundle 里需包含。
- **Linux + PipeWire/PulseAudio**（需要 `pactl` 命令）→ 声卡循环。无 `pactl` 的系统退化为不循环（普通背景仍可用）。
- **ffmpeg / ffprobe**（系统安装）→ 本地视频探测与 MKV 转封装。无则本地视频功能不可用。
- **hls.js / flv.js**（已内置于插件目录 `vendor/`，随包发布）→ 直播与 Jellyfin HLS 原生播放。
- 浏览器能访问 bilibili.com / youtube.com / twitch.tv（Twitch 需要浏览器能翻墙）。
- 可选：**Jellyfin 服务器**（自建或远程，如 `http://192.168.x.x:8096`）→ 高规格视频解码与媒体库卡片。
- 可选：**本地 vLLM / 任意 OpenAI 兼容端点**（如 `http://127.0.0.1:8000/v1`）→ `/playask` AI 推荐；无则走随机兜底。
- 可选：本地 HTTP/SOCKS 代理（如 Clash 的 `127.0.0.1:7897`）用于外网搜索兜底。
- 其它系统工具：`curl`（搜索/取流/API 调用）、`python3`（Cookie 数据库读取）。

## 安装

放进 web profile 作为持久插件：

```
~/.dsh/profiles/web/
├── plugins/dsh-plugin-ambient-video/   ← 本包
├── package.json                        ← 加 "dsh-plugin-ambient-video": "file:./plugins/dsh-plugin-ambient-video"
└── cordis.patch.yml                    ← 加：
   - insert:
       - id: ambient-video
         name: 'dsh-plugin-ambient-video'
```

重启 `dsh web`（`systemctl --user restart dsh-web` 或你的方式），浏览器强制刷新（`Ctrl+Shift+R`）。

## 使用

1. 侧栏/设置页输入框粘贴 B 站 / YouTube 链接（或 BV 号）回车，或直接 `/playurl <链接>`——视频铺满全屏成为毛玻璃背景。
2. `/playsearch <歌名>` 国内搜 B 站并播放第一个结果；`/playsearchw <歌名>` 外网搜油管。
3. `/playlocal ~/视频/xxx.mkv` 播放本地视频（自动转封装）；设置页可浏览目录选文件。
4. `/playlive 2145` 或 `/playlive twitch:频道名` 播放直播。
5. 设置页 Jellyfin 区填服务器 + 账号 → 连接 → 选媒体库 → 点卡片播放高规格视频。
6. 设置页收藏区点「从 Firefox 读」提取 Cookie → 加载收藏夹 → 卡片网格点播。
7. `/playask 适合做工作背景的轻音乐`——AI 从收藏里选片出卡片。
8. `/playstop` 暂停；再输入同一链接即从头播放。
9. 设置 →「氛围背景视频」：调透明度/亮度/毛玻璃、开弹幕、设搜索代理、配 AI 端点等。

## 契约依赖

- **`web` 服务**（搜索/抓取）：`web.search` 兜底与 `/ambient-info` 的 `web.fetch`——由 dsh-free-search 或等价 provider 提供。
- **`commands` / `webServer` / `shell` / `timer`**：DSH 宿主服务——命令注册、HTTP 路由（双向）、`pactl`/`curl` 执行、延时。
- **`shell` 半区的系统能力**：`pactl`（声卡检测）、`curl`（B 站搜索 API / AnySearch / 取流）。
- **客户端**：`react`（web app 提供）、`slots` / `timer` 服务；`window.localStorage` 持久化。
- 路由前缀 `/ambient-*` 为发布命名空间，避免与其它实例冲突。

## 已知限制与后续工作

- **声卡循环依赖音频输出**：视频会一直播（剪裁/暂停检测基于 Chrome 音频流）；静音播放不循环；机器无音频/无 pactl 时不循环（背景仍正常显示）。
- **重挂为跨域 iframe 全量重载**：B 站播放器无法被外部控制停止/续播（父页读不到播放状态），"播完重播"靠声卡信号 + 重挂实现，约 2.5–3s 延迟；非手势重挂的带声音自动播放可能被浏览器策略拦截（会按逻辑重试；也可改用静音或 B 站网页原生循环）。
- **B 站搜索 412 风控**：换 IP / 高频使用时更明显；已做重试 + AnySearch/Bing 多源兜底 + 5s 超时报错。
- **B 站嵌入遥测噪音**：播放器偶发控制台报错/登录提示（播放器 UI 行为），视频流本身公开视频无需登录。
- 未来方向：原生 `<video>` 直接播放视频流（无 UI、零延迟原生 loop，需 Host 流式代理）；搜索代理改为按站点粒度。

## 依赖说明

- **`dsh-free-search`（>=0.4）**：peer 依赖，提供 web 搜索/抓取 provider（AnySearch 引擎 + 本机代理兜底外网）。
- **`react`（>=18）**：浏览器半区经 web app 提供。
- 无 npm 运行时依赖；系统工具 `pactl`/`curl` 见「环境要求」。

## 发布

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/Gitlandfor/dsh-plugin-ambient-video |
| 版本 | v1.0.0（MIT） |
| Release + 演示视频资产 | https://github.com/Gitlandfor/dsh-plugin-ambient-video/releases/tag/v1.0.0 （`demo.mp4` 为演示视频） |