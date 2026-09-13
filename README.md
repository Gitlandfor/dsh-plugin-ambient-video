# dsh-plugin-ambient-video（氛围背景视频）

A DSH web-profile plugin that puts a fullscreen **frosted-glass ambient video** behind your whole DeepSeek Harness UI — with **sound-card state looping** for Bilibili, native loop for YouTube, and adjustable transparency/brightness/blur.

## Features

- 🎞️ **Fullscreen ambient background**: Bilibili / YouTube / any direct link, cropped & frosted (no player UI).
- 🔁 **Single-loop by sound-card state** (Linux): the host watches the system audio via `pactl`; when the video's audio stops (it ended), the client remounts and replays. Muted playback has no audio signal → no loop.
- 🌐 **Commands**:
  - `/playurl <any-link>` — play/switch background video
  - `/playstop` — pause
  - `/playsearch <keyword>` — domestic search (Bilibili-first: official API → AnySearch → Bing)
  - `/playsearchw <keyword>` — global search (YouTube-first via proxy)
- ⚙️ **Settings page**: opacity / brightness / blur / danmaku / mute / loop toggle / **search proxy** (configurable, empty = direct).
- 💾 All settings persist in browser localStorage.

## Requirements

- DSH web profile (persistent plugins mechanism)
- **Linux + PipeWire/PulseAudio** (`pactl`) for the sound-card loop
- Browser with bilibili.com / youtube.com reachable (YouTube needs an accessible network, e.g. a proxy)
- Optional local proxy (e.g. Clash at `127.0.0.1:7897`) for the global search — configurable in settings, not required for domestic search

## Install

Drop it into your web profile as a persistent plugin:

```
~/.dsh/profiles/web/
├── plugins/dsh-plugin-ambient-video/   ← this package
├── package.json                        ← add "dsh-plugin-ambient-video": "file:./plugins/dsh-plugin-ambient-video"
└── cordis.patch.yml                    ← add:
   - insert:
       - id: ambient-video
         name: 'dsh-plugin-ambient-video'
```

Restart `dsh web` and hard-refresh the page.

## Notes

- Bilibili's search API is risk-controlled (intermittent 412); the plugin auto-retries and falls back across multiple sources.
- Bilibili embed may surface its native login/tracker prompts occasionally; the raw stream itself needs no login for public videos.