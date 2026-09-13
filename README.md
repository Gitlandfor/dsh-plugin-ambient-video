# dsh-plugin-ambient-video · 氛围背景视频

给 DeepSeek Harness 加一个铺满全屏的**毛玻璃氛围背景视频**——支持 B 站 / YouTube / 任意直链，B 站用**声卡状态检测循环**（播完自动重播），YouTube 原生循环，透明度 / 亮度 / 模糊全部可调。

> English: A fullscreen frosted-glass ambient background video for the DSH web GUI. Bilibili loops by sound-card state, YouTube by native loop. See the [English notes](#english-notes) below.

## 功能

- 🎞️ **全屏毛玻璃背景**：B 站 / YouTube / 任意视频链接，自动裁剪播放器 UI，只留画面
- 🔁 **单曲循环（声卡检测）**：Host 用 `pactl` 监听系统音频——视频播完（音频停止）→ 自动重挂重播。静音播放没有音频信号，不循环
- 🎛️ **命令**：
  - `/playurl <任意链接>` — 播放 / 切换背景视频
  - `/playstop` — 暂停
  - `/playsearch <关键词>` — 国内搜索（B 站优先：官方 API → AnySearch → Bing）
  - `/playsearchw <关键词>` — 外网搜索（YouTube 优先，走代理）
- ⚙️ **设置页**：透明度 / 亮度 / 毛玻璃强度 / 弹幕 / 静音 / 单曲循环开关 / **搜索代理**（可配，留空=直连）
- 💾 设置自动保存（浏览器 localStorage）

## 环境要求

- DSH web profile（持久插件机制）
- **Linux + PipeWire/PulseAudio**（需要 `pactl`）→ 声卡循环
- 浏览器能访问 bilibili.com / youtube.com（YouTube 需要网络可达，例如有代理）
- 可选：本地代理（如 Clash 的 `127.0.0.1:7897`）用于外网搜索（设置页可改；国内搜索不依赖代理）

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

重启 `dsh web` 并强制刷新页面（`Ctrl+Shift+R`）。

## 注意事项

- B 站搜索 API 有风控（间歇 412）：插件会自动重试并多源兜底。
- B 站嵌入播放器偶尔会弹登录/遥测提示（播放器 UI 行为）；视频流本身公开视频**无需登录**。
- 发布版路由前缀为 `/ambient-*`（`/ambient-info`、`/ambient-audio-state`、`/ambient-config`），避免与其它实例冲突。

## English notes

- **License**: MIT. Install by dropping into `~/.dsh/profiles/web/plugins/`, adding the `file:` dependency in `package.json`, and the `- insert` row in `cordis.patch.yml`, then restart `dsh web`.
- **Loop**: Bilibili replays by monitoring the system audio (`pactl`); muted playback has no audio signal and will not loop. YouTube uses the native `loop=1&playlist=` embed parameter.
- **Proxy**: the global search (AnySearch) goes through a configurable local proxy (default `http://127.0.0.1:7897`); empty = direct. Domestic search never needs it.