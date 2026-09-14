# dsh-plugin-ambient-video

English | [简体中文](README.md)

> A fullscreen **frosted-glass ambient background video** for the DeepSeek Harness Web GUI. Supports Bilibili / YouTube / any direct video link; the player UI is cropped away leaving only the picture. Bilibili loops by **sound-card state detection** (auto-replay when playback ends), YouTube loops natively; opacity / brightness / frosted-glass blur are all adjustable and persist in the browser.

This repo is a DSH web-profile plugin package: the host half registers the `/playurl /playstop /playsearch /playsearchw` commands and the `/ambient-info`, `/ambient-audio-state`, `/ambient-config` routes (video info, sound-card detection, config sync); the browser half renders the fullscreen backdrop layer and the settings page (opacity / brightness / blur / danmaku / mute / loop / search proxy), and polls the host's sound-card state to remount and replay when the video ends.

## Demo

- **Release v1.0.0**: https://github.com/Gitlandfor/dsh-plugin-ambient-video/releases/tag/v1.0.0
- **`demo-6-26s.mp4` — demo video** (a 6–26s clip of a screen recording showing the frosted-glass backdrop + play/stop/search): open the Release link → Assets → preview/download `demo-6-26s.mp4`.

## Features

- **Fullscreen frosted-glass backdrop**: Bilibili / YouTube / any video link; the iframe is zoomed and cropped so the player UI disappears, leaving only the picture. Opacity (default 50%), brightness (default 120%) and blur (default 6px) are live-adjustable.
- **Single-loop by sound-card state**: the host watches the system audio via `pactl` — when a Bilibili video ends (the Chrome audio stream disappears), the client remounts and replays (~2.5–3s latency); if a remount stays silent it retries up to 2 times. **Muted playback has no audio signal and does not loop.** YouTube uses the native `loop=1&playlist=` parameter for seamless looping.
- **Commands**:
  - `/playurl <any-link>` — play / switch the background video (dedicated Bilibili/YouTube embeds; anything else is iframe-embedded directly)
  - `/playstop` — pause (entering the link again replays from the start)
  - `/playsearch <keyword>` — domestic search (Bilibili-first: official API → AnySearch → Bing)
  - `/playsearchw <keyword>` — global search (YouTube-first, via proxy)
- **Settings page**: opacity / brightness / frosted blur / danmaku (Bilibili only) / mute / loop toggle / **search proxy** (configurable; empty = direct), all persisted in browser localStorage.
- **Search resilience**: the Bilibili search API is risk-controlled (intermittent 412) — auto-retry plus multi-source fallbacks; a 5-second hard timeout reports errors clearly.

## Requirements

- A DSH web profile (persistent plugin mechanism).
- **dsh-free-search** (peer dependency) — provides the `web.search` / `web.fetch` services; include it in the profile bundle.
- **Linux + PipeWire/PulseAudio** (`pactl`) for the sound-card loop. Without `pactl`, the loop degrades to no-loop (the background still works).
- The browser must reach bilibili.com / youtube.com (YouTube needs an accessible network).
- Optional: a local HTTP/SOCKS proxy (e.g. Clash at `127.0.0.1:7897`) for the global search fallback — configurable in settings; domestic search never needs it.
- Other system tools: `curl`. The plugin takes capabilities only through DSH services; no npm runtime dependencies.

## Install

Drop it into the web profile as a persistent plugin:

```
~/.dsh/profiles/web/
├── plugins/dsh-plugin-ambient-video/   ← this package
├── package.json                        ← add "dsh-plugin-ambient-video": "file:./plugins/dsh-plugin-ambient-video"
└── cordis.patch.yml                    ← add:
   - insert:
       - id: ambient-video
         name: 'dsh-plugin-ambient-video'
```

Restart `dsh web` (`systemctl --user restart dsh-web` or your usual way) and hard-refresh the browser (`Ctrl+Shift+R`).

## Usage

1. Paste a Bilibili / YouTube link (or a BV id) into the settings-page input and press Enter, or run `/playurl <link>` — the video fills the screen as the frosted-glass backdrop.
2. `/playsearch <song>` searches Bilibili domestically and plays the first result; `/playsearchw <song>` searches YouTube globally.
3. `/playstop` pauses; entering the same link again replays from the start.
4. Settings →「氛围背景视频」: adjust opacity/brightness/blur, enable danmaku, set the search proxy, toggle the loop, etc.
5. With an unmuted Bilibili video, the settings page shows 「声卡循环：轮询中…」and auto-replays when it ends.

## Contract dependencies

- **`web` service** (search/fetch): `web.search` fallback and `web.fetch` in `/ambient-info` — provided by dsh-free-search or an equivalent provider.
- **`commands` / `webServer` / `shell` / `timer`**: DSH host services — command registration, HTTP routes, `pactl`/`curl` execution, delays.
- **Host system capabilities**: `pactl` (sound-card detection), `curl` (Bilibili search API / AnySearch / fetch).
- **Client**: `react` (provided by the web app), `slots` / `timer` services; `window.localStorage` persistence.
- The `/ambient-*` route prefix is the release namespace to avoid cross-instance collisions.

## Known limitations & roadmap

- **The loop depends on audio output**: it detects playback end via the Chrome audio stream; muted playback does not loop; machines without audio/pactl do not loop (the background still displays).
- **Remount is a full cross-origin iframe reload**: the Bilibili player cannot be externally paused/resumed (the parent page cannot read its playback state), so "replay on end" uses the sound-card signal + remount with ~2.5–3s latency; unmuted autoplay on a non-gesture remount may be blocked by the browser policy (it retries; muted playback or Bilibili's web-native loop are alternatives).
- **Bilibili search 412 risk control**: more visible on other IPs / under high frequency; retry + AnySearch/Bing fallbacks + a 5s timeout are in place.
- **Bilibili embed telemetry noise**: the player occasionally logs console errors / login prompts (player-UI behavior); the raw stream itself needs no login for public videos.
- Roadmap: native `<video>` playback of the raw stream (no UI, zero-latency native loop, requires a host streaming proxy); per-site proxy configuration.

## Dependencies

- **`dsh-free-search` (>=0.4)**: peer dependency providing the web search/fetch providers (the AnySearch engine + local-proxy fallback for the global web).
- **`react` (>=18)**: provided by the web app for the browser half.
- No npm runtime dependencies; the `pactl`/`curl` system tools are listed under Requirements.

## Release

| Item | Value |
|---|---|
| Repository | https://github.com/Gitlandfor/dsh-plugin-ambient-video |
| Version | v1.0.0 (MIT) |
| Release + demo asset | https://github.com/Gitlandfor/dsh-plugin-ambient-video/releases/tag/v1.0.0 (`demo-6-26s.mp4` is the demo video) |