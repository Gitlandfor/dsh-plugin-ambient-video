# dsh-plugin-ambient-video · 氛围背景视频

[English](README.en.md) | 简体中文

> 给 DeepSeek Harness 的 Web GUI 加一层**铺满全屏的毛玻璃氛围背景视频**：支持 B 站 / YouTube / 任意视频链接，自动裁剪播放器 UI 只留画面；B 站用**电脑声卡状态检测**实现单曲循环（播完自动重播），YouTube 用原生 loop；透明度 / 亮度 / 毛玻璃强度全部可调，设置自动保存。

本仓库是一个 DSH web profile 的外插件包：host 半区注册 `/playurl /playstop /playsearch /playsearchw` 命令与 `/ambient-info`、`/ambient-audio-state`、`/ambient-config` 路由（搜索、视频信息、声卡检测、代理配置）；浏览器半区渲染 shell 浮层背景层与设置页（透明度/亮度/毛玻璃/弹幕/静音/循环/搜索代理），并轮询 host 的声卡状态在视频播完时自动重挂重播。

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
- **设置页**：背景透明度 / 背景亮度 / 毛玻璃强度 / 显示弹幕（仅 B 站）/ 静音播放 / 单曲循环开关 / **搜索代理**（可配，留空=直连），全部自动保存（浏览器 localStorage）。
- **搜索容错**：B 站官方 API 有风控（间歇 412），自动重试并多源兜底；整体 5 秒硬超时，超时明确报错。

## 环境要求

- DSH web profile（持久插件机制）。
- **dsh-free-search**（peer 依赖）——提供 `web.search` / `web.fetch` 搜索与抓取服务；profile bundle 里需包含。
- **Linux + PipeWire/PulseAudio**（需要 `pactl` 命令）→ 声卡循环。无 `pactl` 的系统退化为不循环（普通背景仍可用）。
- 浏览器能访问 bilibili.com / youtube.com（YouTube 需要网络可达）。
- 可选：本地 HTTP/SOCKS 代理（如 Clash 的 `127.0.0.1:7897`）用于外网搜索兜底——设置页可改，留空=直连，国内搜索不依赖代理。
- 其它系统工具：`curl`（搜索/取流）。代码运行时只通过 DSH 服务取能力，无 npm 运行时依赖。

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
3. `/playstop` 暂停；再输入同一链接即从头播放。
4. 设置 →「氛围背景视频」：调透明度/亮度/毛玻璃、开弹幕、**设搜索代理**、关闭单曲循环等。
5. B 站非静音播放时：设置页"循环状态"显示「声卡循环：轮询中…」，播完自动重播。

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