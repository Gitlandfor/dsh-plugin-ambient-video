// dsh-plugin-ambient-video — 氛围背景视频（持久版）
// VOD(iframe 嵌入) + 本地视频/直播/Jellyfin(原生 <video>) + B站收藏推荐
// Host 半：命令 playurl/playstop/playsearch/playsearchw/playlocal/playlive
// 路由：/ambient-info/ /ambient-audio-state /ambient-config /ambient-probe /ambient-local/
//       /ambient-list /ambient-live /ambient-vendor/ /ambient-jf/* /ambient-fav/* /ambient-cookie/*
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import http from 'node:http'
import https from 'node:https'

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v', '.mkv', '.ts', '.m2ts', '.mts', '.avi', '.flv'])
const MIME = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.ogv': 'video/ogg',
  '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.ts': 'video/mp2t', '.m2ts': 'video/mp2t', '.mts': 'video/mp2t',
  '.avi': 'video/x-msvideo', '.flv': 'video/x-flv',
}

function apply(ctx) {
  const commands = ctx.get('commands')
  const webServer = ctx.get('webServer')
  const web = ctx.get('web')
  const shell = ctx.get('shell')
  const llm = ctx.get('llm')   // DSH 统一模型服务（provider 在 settings.yaml 配好）
  const timer = ctx.get('timer')

  // ---- 运行期配置（客户端 localStorage 持久化，启动时 POST 同步过来）----
  let searchProxy = 'http://127.0.0.1:7897'
  let localRoot = path.join(os.homedir(), '视频')
  let biliCookieStr = ''      // 完整 Cookie 串（粘贴 或 浏览器读取）
  let cookieSource = ''       // paste | firefox | chrome

  // ---- Jellyfin 会话（登录后持有 token）----
  let jf = null // { server, token, userId, userName }

  // ---- 小工具 ----
  const json = (res, obj, status) => {
    try { res.writeHead(status || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) } catch (e) {}
  }
  const delay = async () => { if (timer) { try { await timer.timeout(300) } catch (e) {} } }
  const R = (p) => path.resolve(p)
  const esc = (p) => JSON.stringify(String(p)) // 拼 shell 参数的 JSON 字面量（安全）

  // ---- B站收藏辅助（curlJson / wbi 签名；供 /ambient-fav/* 路由与 /playask 共用）----
  const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36'
  async function curlJson(url, referer) {
    if (!shell) return null
    const cookieArg = biliCookieStr ? ' -b ' + JSON.stringify(biliCookieStr) : ''
    const cmd = 'curl -s --max-time 12' + cookieArg + ' -A ' + JSON.stringify(UA) + ' -H ' + JSON.stringify('Referer: ' + (referer || 'https://www.bilibili.com/')) + ' ' + JSON.stringify(url)
    const spec = shell.resolve({ command: cmd, timeoutMs: 18000, stdoutMaxBytes: 2097152 })
    const r = await shell.run(spec)
    try { return JSON.parse(r && r.stdout ? (r.stdout.text || '') : '') } catch (e) { return null }
  }
  // wbi 签名（bilibili-API-collect 标准算法）
  const WBI_TABLE = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52]
  async function wbiKey() {
    const nav = await curlJson('https://api.bilibili.com/x/web-interface/nav')
    if (!nav || nav.code !== 0 || !nav.data || !nav.data.wbi_img) return null
    const mk = (urlStr) => { const s = String(urlStr).split('/').pop() || ''; return s.split('.')[0] }
    const raw = mk(nav.data.wbi_img.img_url) + mk(nav.data.wbi_img.sub_url)
    let mixin = ''
    for (const i of WBI_TABLE) mixin += raw[i]
    return mixin
  }
  async function wbiSign(params) {
    const mixin = await wbiKey()
    const p = Object.assign({}, params)
    if (mixin) {
      p.wts = Math.round(Date.now() / 1000)
      const q = Object.keys(p).sort().map((k) => k + '=' + encodeURIComponent(p[k])).join('&')
      p.w_rid = crypto.createHash('md5').update(q + mixin).digest('hex')
    }
    return Object.keys(p).map((k) => k + '=' + encodeURIComponent(p[k])).join('&')
  }
  let navCache = { at: 0, mid: 0 }
  async function getMid() {
    if (navCache.mid && Date.now() - navCache.at < 300000) return navCache.mid
    const nav = await curlJson('https://api.bilibili.com/x/web-interface/nav')
    const mid = nav && nav.code === 0 && nav.data ? Number(nav.data.mid) || 0 : 0
    navCache = { at: Date.now(), mid }
    return mid
  }

  // ---- AI 推荐配置（客户端设置页选择后端）----
  let aiProvider = 'vllm-local'   // DSH provider route（settings.yaml -> llm-pi-ai.providers）
  let aiBase = 'http://127.0.0.1:8000/v1'
  let aiModel = ''
  let aiKey = ''
  let aiEnabled = true
  let aiCount = 3
  // 说明(补理由) AI 独立配置：留空 = 跟随选卡 AI
  let reasonBase = ''
  let reasonModel = ''
  let reasonKey = ''
  let reasonEnabled = true
  let reasonProvider = ''   // 空 = 跟随 aiProvider
  // 最近一次 AI 选卡结果（供客户端轮询 /ambient-ask/state，绕过聊天行渲染时序）
  let askSeq = 0
  let askLast = null

  // provider 已配但模型名留空时，自动取该 provider 的第一个模型
  async function resolveModel(provider, wanted) {
    if (wanted) return wanted
    if (!llm || !provider) return ''
    try {
      const ms = await llm.listModels(provider)
      if (ms && ms.length) return String((ms[0] && ms[0].id) || '')
    } catch (e) {}
    return ''
  }

  async function aiModels(cfg) {
    const provider = (cfg && cfg.provider) || aiProvider
    if (llm && provider) {
      try {
        const ms = await llm.listModels(provider)
        const ids = (ms || []).map((m) => String(m.id || '')).filter(Boolean)
        if (ids.length) return ids
      } catch (e) { /* 回落 */ }
    }
    const base = (cfg && cfg.base) || aiBase
    const key = (cfg && cfg.key) || aiKey
    if (!shell || !base) return []
    const h = key ? ' -H ' + JSON.stringify('Authorization: Bearer ' + key) : ''
    const cmd = 'curl -s --max-time 6' + h + ' ' + JSON.stringify(base.replace(/\/+$/, '') + '/models')
    const spec = shell.resolve({ command: cmd, timeoutMs: 10000, stdoutMaxBytes: 524288 })
    const r = await shell.run(spec)
    try {
      const d = JSON.parse(r && r.stdout ? (r.stdout.text || '') : '{}')
      return Array.isArray(d.data) ? d.data.map((m) => String(m.id || '')).filter(Boolean) : []
    } catch (e) { return [] }
  }

  // ---- AI 调用：优先走 DSH 的 llm 服务（与 /speak 同源，provider 在 settings.yaml 配好）----
  // ---- llm 服务不可用时回落到直接 curl vLLM（临时文件必须在 curl 读完之后才删）----
  async function aiChat(userContent, maxTokens, cfg) {
    const provider = (cfg && cfg.provider) || aiProvider
    const model = await resolveModel(provider, (cfg && cfg.model) || aiModel)
    if (llm && provider && model) {
      try {
        let sys = ''
        const msgs = []
        for (const m of userContent || []) {
          if (!m || typeof m !== 'object') continue
          const t = String(m.content || '')
          if (m.role === 'system') { sys = sys ? sys + '\n' + t : t; continue }
          msgs.push({ id: 'ai-' + msgs.length, role: m.role === 'assistant' ? 'assistant' : 'user', content: [{ type: 'text', text: t }], source: { kind: m.role === 'assistant' ? 'model' : 'user' } })
        }
        const stream = llm.stream({ provider: provider, model: model, system: sys || undefined, messages: msgs, maxTokens: maxTokens || 1024, temperature: 0.3 })
        let buf = ''
        for await (const c of stream) { if (c && c.type === 'text-delta') buf += c.text }
        const out = buf.trim()
        if (out) return out
      } catch (e) { /* 回落 curl */ }
    }
    const base = (cfg && cfg.base) || aiBase
    const key = (cfg && cfg.key) || aiKey
    if (!shell || !base) return null
    const body = { model: model || 'local-model', messages: userContent, temperature: 0.3, max_tokens: maxTokens || 1024 }
    const tmp = path.join(os.tmpdir(), 'dsh-ai-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.json')
    fs.writeFileSync(tmp, JSON.stringify(body))
    const h = key ? ' -H ' + JSON.stringify('Authorization: Bearer ' + key) : ''
    const cmd = 'curl -s --max-time 40 -X POST -H ' + JSON.stringify('Content-Type: application/json') + h + ' -d @' + JSON.stringify(tmp) + ' ' + JSON.stringify(base.replace(/\/+$/, '') + '/chat/completions')
    let r
    try {
      const spec = shell.resolve({ command: cmd, timeoutMs: 45000, stdoutMaxBytes: 1048576 })
      r = await shell.run(spec)
    } finally {
      try { fs.unlinkSync(tmp) } catch (e) {}   // 必须在 curl 读完后才能删
    }
    try {
      const d = JSON.parse(r && r.stdout ? (r.stdout.text || '') : '')
      const msg = d && d.choices && d.choices[0] && d.choices[0].message ? String(d.choices[0].message.content || '') : ''
      return msg || null
    } catch (e) { return null }
  }

  // 拉取收藏条目（跨前几个收藏夹，最多 limit 条）
  async function loadFavItems(limit) {
    const mid = await getMid()
    if (!mid) return []
    const d = await curlJson('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + mid + '&rid=0', 'https://space.bilibili.com/' + mid + '/favlist')
    const folders = (d && d.code === 0 && d.data && d.data.list) || []
    const out = []
    const max = limit || 40
    for (const f of folders) {
      if (out.length >= max) break
      const q = await wbiSign({ media_id: String(f.id), pn: 1, ps: 20, platform: 'web', order: 'mtime' })
      const dl = await curlJson('https://api.bilibili.com/x/v3/fav/resource/list?' + q, 'https://www.bilibili.com/medialist/detail/ml' + f.id)
      const medias = (dl && dl.code === 0 && dl.data && dl.data.medias) || []
      for (const m of medias) {
        if (out.length >= max) break
        if (!m.bvid) continue
        out.push({ bvid: String(m.bvid), title: String(m.title || ''), pic: String(m.cover || ''), duration: Number(m.duration || 0), up: String((m.upper && m.upper.name) || '') })
      }
    }
    return out
  }

  function expandHome(p) {
    p = String(p || '').trim()
    if (!p) return ''
    if (p === '~') return os.homedir()
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
    return p
  }
  function realpathSafe(p) {
    try { return fs.realpathSync(p) } catch (e) { return null }
  }
  function withinRoots(real) {
    if (!real) return false
    const roots = [localRoot, path.join(os.homedir(), '视频'), os.homedir(), '/mnt'].filter(Boolean).map(R)
    return roots.some((rt) => real === rt || real.startsWith(rt + path.sep))
  }
  function isVideoFile(p) {
    return VIDEO_EXTS.has(path.extname(p).toLowerCase())
  }

  // ffprobe 探测：{ok, container, codec, width, height, duration, hasAudio, bitrate}
  async function probeFile(p) {
    if (!shell) return null
    try {
      const cmd = 'ffprobe -v quiet -print_format json -show_format -show_streams -- ' + esc(p)
      const spec = shell.resolve({ command: cmd, timeoutMs: 15000, stdoutMaxBytes: 1048576 })
      const r = await shell.run(spec)
      const j = JSON.parse(r && r.stdout ? (r.stdout.text || '') : '{}')
      const streams = Array.isArray(j.streams) ? j.streams : []
      const v = streams.find((s) => s.codec_type === 'video')
      const a = streams.find((s) => s.codec_type === 'audio')
      if (!v) return { ok: false, error: 'no-video-stream' }
      return {
        ok: true,
        container: String((j.format && j.format.format_name) || '').split(',')[0],
        codec: String(v.codec_name || ''),
        width: Number(v.width) || 0,
        height: Number(v.height) || 0,
        duration: Number((j.format && j.format.duration) || v.duration || 0) || 0,
        hasAudio: !!a,
        bitrate: Number((j.format && j.format.bit_rate) || 0) || 0,
      }
    } catch (e) { return { ok: false, error: 'probe-fail' } }
  }

  // MKV/AVI/FLV/M2TS 等浏览器不认的容器 → ffmpeg -c copy 转封装成 mp4（不重编码）
  const remuxCacheDir = path.join(os.tmpdir(), 'dsh-ambient-remux')
  async function ensureRemux(real) {
    try { fs.mkdirSync(remuxCacheDir, { recursive: true }) } catch (e) {}
    try {
      const st = fs.statSync(real)
      const key = crypto.createHash('sha1').update(real + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 20)
      const out = path.join(remuxCacheDir, key + '.mp4')
      if (fs.existsSync(out)) return out
      if (!shell) return null
      const cmd = 'ffmpeg -y -loglevel error -i ' + esc(real) + ' -map 0:v:0 -map 0:a? -c copy -movflags +faststart ' + esc(out)
      const spec = shell.resolve({ command: cmd, timeoutMs: 300000, stdoutMaxBytes: 65536 })
      const r = await shell.run(spec)
      if (!r || String(r.code || r.status || 0) !== '0') return null
      return fs.existsSync(out) ? out : null
    } catch (e) { return null }
  }

  // 扫描多个候选路径找 vendor 目录（DSH 模块加载器可能重写 import.meta.url）
  let vendorDir = null
  const home = os.homedir()
  const candidates = [
    (() => { try { return new URL('.', import.meta.url).pathname } catch (e) { return null } })(),
    path.join(home, '.dsh', 'profiles', 'web', 'plugins', 'dsh-plugin-ambient-video'),
    path.join(home, '.dsh', 'profiles', 'web', 'node_modules', 'dsh-plugin-ambient-video'),
  ]
  for (const c of candidates) {
    if (c && fs.existsSync(path.join(c, 'hls.min.js'))) { vendorDir = c; break }
  }

  // HTTP Range 流式响应（本地 <video> 拖动进度条必需）
  function serveFile(req, res, filePath, mime, extraHeaders) {
    try {
      const stat = fs.statSync(filePath)
      const total = stat.size
      const range = req.headers.range
      let start = 0, end = total - 1, status = 200
      const head = Object.assign({ 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }, extraHeaders || {})
      if (range && /^bytes=(\d*)-(\d*)$/.test(range)) {
        const m = range.match(/^bytes=(\d*)-(\d*)$/)
        if (m[1] !== '') start = parseInt(m[1], 10)
        if (m[2] !== '') end = parseInt(m[2], 10)
        if (start >= total) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + total })
          res.end()
          return
        }
        if (end >= total) end = total - 1
        status = 206
        head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + total
        head['Content-Length'] = end - start + 1
      }
      res.writeHead(status, head)
      if (req.method === 'HEAD') { res.end(); return }
      if (status === 206) fs.createReadStream(filePath, { start, end }).pipe(res)
      else fs.createReadStream(filePath).pipe(res)
    } catch (e) {
      try { res.writeHead(404); res.end('not found') } catch (e2) {}
    }
  }

  if (webServer) {
    // ---- 配置同步 POST：proxy / localRoot / cookie / cookieSource ----
    const offCfg = webServer.register({
      kind: 'exact',
      path: '/ambient-config',
      handler: (req, res) => {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', () => {
          try {
            let p = {}
            try { p = JSON.parse(body || '{}') } catch (e) { p = {} }
            if (typeof p.proxy === 'string') searchProxy = p.proxy.trim()
            if (typeof p.localRoot === 'string' && p.localRoot.trim()) {
              const rt = expandHome(p.localRoot)
              const real = realpathSafe(rt)
              if (real && fs.existsSync(real) && fs.statSync(real).isDirectory()) localRoot = real
            }
            if (typeof p.cookie === 'string') {
              biliCookieStr = p.cookie.replace(/[\r\n"]/g, '').trim()
              cookieSource = typeof p.cookieSource === 'string' ? p.cookieSource : 'paste'
            }
            if (typeof p.aiEnabled === 'boolean') aiEnabled = p.aiEnabled
            if (typeof p.aiProvider === 'string' && p.aiProvider.trim()) aiProvider = p.aiProvider.trim()
            if (typeof p.aiBase === 'string' && p.aiBase.trim()) aiBase = p.aiBase.trim().replace(/\/+$/, '')
            if (typeof p.aiModel === 'string') aiModel = p.aiModel.trim()
            if (typeof p.aiKey === 'string') aiKey = p.aiKey.trim()
            const ac = Number(p.aiCount) || 3
            if (ac >= 1 && ac <= 5) aiCount = ac
            if (typeof p.reasonEnabled === 'boolean') reasonEnabled = p.reasonEnabled
            if (typeof p.reasonProvider === 'string') reasonProvider = p.reasonProvider.trim()
            if (typeof p.reasonBase === 'string') reasonBase = p.reasonBase.trim().replace(/\/+$/, '')
            if (typeof p.reasonModel === 'string') reasonModel = p.reasonModel.trim()
            if (typeof p.reasonKey === 'string') reasonKey = p.reasonKey.trim()
            json(res, { ok: true, proxy: searchProxy, localRoot, cookieSet: !!biliCookieStr, cookieSource, aiEnabled, aiProvider, aiBase, aiModel, aiSet: !!aiModel, reasonEnabled, reasonProvider, reasonBase, reasonModel })
          } catch (e) {
            json(res, { ok: false }, 500)
          }
        })
      },
    })
    ctx.effect(() => offCfg)

    // ---- 视频信息（VOD 时长）----
    const offInfo = webServer.register({
      kind: 'prefix',
      path: '/ambient-info/',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const bvid = String(u.searchParams.get('bvid') || '')
          const page = Number(u.searchParams.get('page') || '1') || 1
          if (!/^BV[0-9A-Za-z]+$/.test(bvid)) { json(res, { duration: 0, error: 'bad-bvid' }); return }
          const apiUrl = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid)
          let text = ''
          let via = ''
          if (web) {
            try { const r = await web.fetch({ url: apiUrl }); text = r && r.body ? String(r.body.content || '') : ''; via = 'web' } catch (e) { text = '' }
          }
          if (!text && shell) {
            try {
              const spec = shell.resolve({ command: 'curl -s --max-time 15 ' + JSON.stringify(apiUrl), timeoutMs: 20000, stdoutMaxBytes: 262144 })
              const r = await shell.run(spec)
              if (r && r.stdout) text = r.stdout.text || ''
              via = 'curl'
            } catch (e) { text = '' }
          }
          const data = JSON.parse(text)
          if (!data || data.code !== 0 || !data.data) { json(res, { duration: 0, error: 'api:' + (data ? String(data.code) : 'empty') }); return }
          const d = data.data
          let duration = Number(d.duration) || 0
          if (page > 1 && Array.isArray(d.pages)) {
            const pg = d.pages.find((x) => Number(x.page) === page)
            if (pg && Number(pg.duration)) duration = Number(pg.duration)
          }
          json(res, { duration, title: String(d.title || ''), pic: String(d.pic || ''), via })
        } catch (e) {
          json(res, { duration: 0, error: 'parse-fail' })
        }
      },
    })
    ctx.effect(() => offInfo)

    // ---- 声卡状态循环 ----
    let audioWas = false
    let restartSeq = 0
    let lastSeqAt = 0
    let retries = 0
    const offAudioState = webServer.register({
      kind: 'exact',
      path: '/ambient-audio-state',
      handler: async (req, res) => {
        let playing = false
        if (shell) {
          try {
            const spec = shell.resolve({ command: 'pactl list sink-inputs 2>/dev/null | grep -i "application.name" | grep -iE "chrom|Google Chrome"', timeoutMs: 5000, stdoutMaxBytes: 16384 })
            const r = await shell.run(spec)
            playing = !!(r && r.stdout && r.stdout.text && r.stdout.text.trim())
          } catch (e) { /* ignore */ }
        }
        const now = Date.now()
        if (playing) {
          audioWas = true
          retries = 0
        } else if (!playing && audioWas) {
          audioWas = false
          restartSeq += 1
          lastSeqAt = now
          retries = 0
        } else if (!playing && restartSeq > 0 && now - lastSeqAt > 8000 && retries < 2) {
          restartSeq += 1
          retries += 1
          lastSeqAt = now
        }
        json(res, { restart: restartSeq, audio: playing })
      },
    })
    ctx.effect(() => offAudioState)

    // ---- 本地文件探测 ?path= ----
    const offProbe = webServer.register({
      kind: 'exact',
      path: '/ambient-probe',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const p = expandHome(u.searchParams.get('path') || '')
          const real = realpathSafe(p)
          if (!real || !withinRoots(real) || !isVideoFile(real)) { json(res, { ok: false, error: 'outside-root-or-not-video' }); return }
          const pr = await probeFile(real)
          if (!pr || !pr.ok) { json(res, { ok: false, error: 'probe-fail' }); return }
          const ext = path.extname(real).toLowerCase()
          const directOk = ['.mp4', '.webm', '.ogg', '.ogv', '.m4v'].includes(ext)
          const chromeCodecOk = ['h264', 'av1', 'vp9'].includes(String(pr.codec))
          json(res, {
            ok: true,
            path: p,
            ext,
            container: pr.container,
            codec: pr.codec,
            width: pr.width,
            height: pr.height,
            duration: pr.duration,
            hasAudio: pr.hasAudio,
            directPlay: directOk && chromeCodecOk,
            needsRemux: !directOk,
            needsJellyfin: !chromeCodecOk,
          })
        } catch (e) { json(res, { ok: false, error: 'probe-fail' }) }
      },
    })
    ctx.effect(() => offProbe)

    // ---- 本地视频 Range 流 ?path=  (MKV 等自动转封装，HEVC 提示走 Jellyfin) ----
    const offLocal = webServer.register({
      kind: 'prefix',
      path: '/ambient-local/',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const p = expandHome(u.searchParams.get('path') || '')
          const real = realpathSafe(p)
          if (!real || !withinRoots(real) || !isVideoFile(real)) {
            if (!res.headersSent) { try { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('denied') } catch (e) {} }
            return
          }
          const ext = path.extname(real).toLowerCase()
          let servePath = real
          let mime = MIME[ext] || 'video/mp4'
          if (ext === '.mkv' || ext === '.avi' || ext === '.flv' || ext === '.m2ts' || ext === '.mts') {
            const pr = await probeFile(real)
            if (pr && pr.codec && !['h264', 'av1', 'vp9'].includes(pr.codec)) {
              try { res.writeHead(415, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'codec-unsupported:' + pr.codec, hint: 'jellyfin' })) } catch (e) {}
              return
            }
            const out = await ensureRemux(real)
            if (!out) {
              try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'remux-failed' })) } catch (e) {}
              return
            }
            servePath = out
            mime = 'video/mp4'
          }
          serveFile(req, res, servePath, mime)
        } catch (e) {
          try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('err') } catch (e2) {}
        }
      },
    })
    ctx.effect(() => offLocal)

    // ---- B站 VOD 直链解析 ?bvid= &page= → {url: durl mp4 直链, duration, title}（fnval=1 老式 durl，480P 匿名可拿）----
    let playurlCache = { at: 0, key: '', url: '', duration: 0, title: '' }
    // 播放令牌：直链由 /ambient-playurl 铸造，浏览器只拿 token 不拿 URL
    // （原 ?url= 白名单只含 bilivideo/bilibili/hdslb，B站第三方 CDN 如 mountaintoys.cn 会被 403；
    //  且客户端传 URL 有 SSRF 面。token 由 Host 自己签，代理查表取链，天然安全且不限 CDN）
    const playTokens = new Map()
    const offPlayurl = webServer.register({
      kind: 'exact',
      path: '/ambient-playurl',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const bvid = String(u.searchParams.get('bvid') || '')
          const page = Number(u.searchParams.get('page') || '1') || 1
          if (!/^BV[0-9A-Za-z]+$/.test(bvid)) { json(res, { ok: false, error: 'bad-bvid' }); return }
          const key = bvid + '|' + page
          const mint = (u) => { const tk = crypto.randomBytes(12).toString('base64url'); playTokens.set(tk, u); if (playTokens.size > 60) { const first = playTokens.keys().next().value; if (first) playTokens.delete(first) }; return tk }
          if (playurlCache.key === key && Date.now() - playurlCache.at < 15000) {
            json(res, { ok: true, url: playurlCache.url, tk: mint(playurlCache.url), duration: playurlCache.duration, title: playurlCache.title, pic: playurlCache.pic || '', cached: true })
            return
          }
          if (!shell) { json(res, { ok: false, error: 'no-shell' }); return }
          // view API 拿 cid（与 /ambient-info 同款：web/curl 双源）
          const viewUrl = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid)
          let vText = ''
          if (web) { try { const r = await web.fetch({ url: viewUrl }); vText = r && r.body ? String(r.body.content || '') : '' } catch (e) { vText = '' } }
          if (!vText) {
            const vSpec = shell.resolve({ command: 'curl -s --max-time 12 ' + JSON.stringify(viewUrl), timeoutMs: 15000, stdoutMaxBytes: 524288 })
            const vr = await shell.run(vSpec)
            if (vr && vr.stdout) vText = vr.stdout.text || ''
          }
          const vd = JSON.parse(vText)
          if (!vd || vd.code !== 0 || !vd.data) { json(res, { ok: false, error: 'view-api:' + String(vd && vd.code) }); return }
          let cid = Number(vd.data.cid) || 0
          if (page > 1 && Array.isArray(vd.data.pages)) {
            const pg = vd.data.pages.find((x) => Number(x.page) === page)
            if (pg && Number(pg.cid)) cid = Number(pg.cid)
          }
          if (!cid) { json(res, { ok: false, error: 'no-cid' }); return }
          // playurl API fnval=1 拿 durl mp4 直链；qn=32(480P) 匿名即可
          const puUrl = 'https://api.bilibili.com/x/player/playurl?bvid=' + encodeURIComponent(bvid) + '&cid=' + cid + '&qn=16&fnval=1&fnver=0'
          const puSpec = shell.resolve({ command: 'curl -s --max-time 12 -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36" -H "Referer: https://www.bilibili.com/" ' + JSON.stringify(puUrl), timeoutMs: 15000, stdoutMaxBytes: 2097152 })
          const pur = await shell.run(puSpec)
          const pd = JSON.parse(pur && pur.stdout ? (pur.stdout.text || '{}') : '{}')
          if (!pd || pd.code !== 0 || !pd.data || !pd.data.durl || !pd.data.durl.length) { json(res, { ok: false, error: 'playurl-api:' + String(pd && pd.code) }); return }
          const url = String(pd.data.durl[0].url || '')
          if (!url) { json(res, { ok: false, error: 'no-durl' }); return }
          playurlCache = { at: Date.now(), key, url, duration: Number(vd.data.duration) || 0, title: String(vd.data.title || ''), pic: String(vd.data.pic || '') }
          json(res, { ok: true, url, tk: mint(url), duration: playurlCache.duration, title: playurlCache.title, pic: playurlCache.pic })
        } catch (e) { json(res, { ok: false, error: 'playurl-fail' }) }
      },
    })
    ctx.effect(() => offPlayurl)

    // ---- B站直链代理转发 ?url= （upos CDN 强制 Referer: bilibili.com，浏览器 <video> 不能自定义 → 必须经 Host 转发；支持 Range）----
    const offProxy = webServer.register({
      kind: 'exact',
      path: '/ambient-proxy',
      handler: (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const tk = String(u.searchParams.get('t') || '')
          const cachedTarget = tk ? (playTokens.get(tk) || '') : ''
          const target = cachedTarget || String(u.searchParams.get('url') || '')
          if (!target) { try { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'no-target' })) } catch (e) {} return }
          // 直传 ?url= 走白名单（只允许 bilibili CDN，防 SSRF）；
          // ?t= 是 Host 自己签的令牌，已在上一步查表取链，无需域名限制
          if (!cachedTarget) {
            const m = target.match(/^https?:\/\/([^/]+)/)
            if (!m || !/(^|\.)(bilivideo\.com|bilibili\.com|hdslb\.com)$/i.test(m[1])) {
              try { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'domain-not-allowed' })) } catch (e) {}
              return
            }
          }
          // 用 http/https 模块转发（带 Referer/UA + Range），数据流式 pipe
          const mod = target.startsWith('https:') ? https : http
          const parsed = new URL(target)
          const headers = {
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            'Referer': 'https://www.bilibili.com/',
          }
          if (req.headers.range) headers['Range'] = req.headers.range
          const out = mod.request({
            hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
            path: parsed.pathname + parsed.search, method: 'GET', headers,
          }, (up) => {
            res.writeHead(up.statusCode || 502, up.headers)
            up.pipe(res)
          })
          out.on('error', () => { try { res.writeHead(502); res.end() } catch (e) {} })
          out.end()
        } catch (e) {
          try { res.writeHead(500); res.end('proxy-err') } catch (e2) {}
        }
      },
    })
    ctx.effect(() => offProxy)

    // ---- 本地目录列表 ?dir= ----
    const offList = webServer.register({
      kind: 'exact',
      path: '/ambient-list',
      handler: (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const p = expandHome(u.searchParams.get('dir') || localRoot)
          const real = realpathSafe(p)
          if (!real || !withinRoots(real)) { json(res, { ok: false, error: 'denied' }); return }
          const entries = fs.readdirSync(real, { withFileTypes: true }).map((e) => {
            const full = path.join(real, e.name)
            let isDir = e.isDirectory()
            let size = 0
            if (!isDir) { try { size = fs.statSync(full).size } catch (e2) {} }
            return { name: e.name, isDir, size, video: !isDir && isVideoFile(full) }
          }).filter((e) => e.isDir || e.video).sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'zh'))
          json(res, { ok: true, dir: real, entries })
        } catch (e) { json(res, { ok: false, error: 'list-fail' }) }
      },
    })
    ctx.effect(() => offList)

    // ---- B站直播取流 ?room= ----
    let liveCache = { at: 0, room: '', url: '', format: '', title: '' }
    const offLive = webServer.register({
      kind: 'exact',
      path: '/ambient-live',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          let room = String(u.searchParams.get('room') || '').trim()
          const m = room.match(/live\.bilibili\.com\/(\d+)/)
          if (m) room = m[1]
          if (!/^\d+$/.test(room)) { json(res, { ok: false, error: 'bad-room' }); return }
          if (liveCache.room === room && Date.now() - liveCache.at < 15000) { json(res, { ok: true, url: liveCache.url, format: liveCache.format, title: liveCache.title }); return }
          const runOnce = async () => {
            const cmd = 'curl -s --max-time 5 -c /tmp/amb_live_ck.txt -o /dev/null https://live.bilibili.com/ && curl -s --max-time 10 -b /tmp/amb_live_ck.txt -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36" -H "Referer: https://live.bilibili.com/" "https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=' + room + '&protocol=0,1&format=0,1,2&codec=0,1&qn=150&platform=h5&ptype=8"'
            const spec = shell.resolve({ command: cmd, timeoutMs: 16000, stdoutMaxBytes: 2097152 })
            const r = await shell.run(spec)
            try {
              const d = JSON.parse(r && r.stdout ? (r.stdout.text || '') : '')
              if (!d || d.code !== 0) return null
              const info = (d.data && d.data.playurl_info && d.data.playurl_info.playurl && d.data.playurl_info.playurl.stream) || []
              let best = null
              for (const st of info) {
                const proto = String(st.protocol_name || '')
                const fmts = Array.isArray(st.format) ? st.format : []
                for (const f of fmts) {
                  const codecs = Array.isArray(f.codec) ? f.codec : []
                  for (const c of codecs) {
                    const cname = String(c.codec_name || '')
                    const urls = Array.isArray(c.url_info) ? c.url_info : []
                    for (const ui of urls) {
                      const full = String(ui.host || '').replace(/\/+$/, '') + String(c.base_url || '') + String(ui.extra || '')
                      if (!full || cname !== 'avc') continue // 只挑 h264 保证浏览器能解
                      const score = (proto === 'http_hls' ? 2 : 1) + (String(f.format_name || '') === 'fmp4' ? 0.5 : 0)
                      if (!best || score > best.score) best = { score, url: full, format: proto === 'http_hls' ? 'hls' : 'flv' }
                    }
                  }
                }
              }
              if (!best) return null
              const title = String((d.data && d.data.room_info && d.data.room_info.title) || 'B站直播')
              return { url: best.url, format: best.format, title }
            } catch (e) { return null }
          }
          let hit = null
          if (shell) hit = await runOnce()
          if (!hit && shell) hit = await runOnce()
          if (!hit) { json(res, { ok: false, error: 'live-fail-412' }); return }
          liveCache = { at: Date.now(), room, url: hit.url, format: hit.format, title: hit.title }
          json(res, { ok: true, url: hit.url, format: hit.format, title: hit.title })
        } catch (e) { json(res, { ok: false, error: 'live-fail' }) }
      },
    })
    ctx.effect(() => offLive)

    // ---- vendor 静态文件（hls.js/flv.js）----
    const offVendor = webServer.register({
      kind: 'prefix',
      path: '/ambient-vendor',
      handler: (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const name = path.basename(u.pathname || '')
          if (!/^(hls|flv)\.min\.js$/.test(name) || !vendorDir) { try { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({debug:'no-vendorDir',vendorDir,name})) } catch (e) {} return }
          const f = path.join(vendorDir, name)
          if (!fs.existsSync(f)) { try { res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({debug:'file-not-found',path:f,name})) } catch (e) {} return }
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' })
          fs.createReadStream(f).pipe(res)
        } catch (e) { try { res.writeHead(500); res.end() } catch (e2) {} }
      },
    })
    ctx.effect(() => offVendor)

    // ---- Jellyfin ----
    async function jfCall(method, apiPath, body) {
      if (!jf || !shell) return { ok: false, error: 'no-jf' }
      let tmpFile = null
      let dataArg = ''
      if (body !== undefined) {
        tmpFile = path.join(os.tmpdir(), 'dsh-jf-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.json')
        fs.writeFileSync(tmpFile, JSON.stringify(body))
        dataArg = " -d '@" + tmpFile + "'"
      }
      const cmd = 'curl -s --max-time 15 -X ' + method + ' -H ' + JSON.stringify('X-Emby-Token: ' + jf.token) +
        ' -H ' + JSON.stringify('Content-Type: application/json') + dataArg + ' ' + JSON.stringify(jf.server.replace(/\/+$/, '') + apiPath)
      const spec = shell.resolve({ command: cmd, timeoutMs: 20000, stdoutMaxBytes: 2097152 })
      const r = await shell.run(spec)
      if (tmpFile) { try { fs.unlinkSync(tmpFile) } catch (e) {} }
      if (!r || !r.stdout || !r.stdout.text) return { ok: false, error: 'jf-net' }
      try { return { ok: true, data: JSON.parse(r.stdout.text) } } catch (e) { return { ok: false, error: 'jf-parse' } }
    }
    const offJfLogin = webServer.register({
      kind: 'exact',
      path: '/ambient-jf/login',
      handler: (req, res) => {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', async () => {
          try {
            const p = JSON.parse(body || '{}')
            const server = String(p.server || '').trim().replace(/\/+$/, '')
            const user = String(p.user || '').trim()
            const pass = String(p.pass || '')
            if (!/^https?:\/\/.+/.test(server) || !user) { json(res, { ok: false, error: 'bad-input' }); return }
            if (!shell) { json(res, { ok: false, error: 'no-shell' }); return }
            if (jf && jf.server === server) { json(res, { ok: true, server, user: jf.userName, cached: true }); return }
            const tmp = path.join(os.tmpdir(), 'dsh-jf-' + Date.now() + '.json')
            fs.writeFileSync(tmp, JSON.stringify({ Username: user, Pw: pass }))
            const cmd = 'curl -s --max-time 15 -X POST -H ' + JSON.stringify('X-Emby-Authorization: MediaBrowser Client="dsh-ambient", Device="dsh-web-browser", DeviceId="dsh-ambient-001", Version="1.0.0"') +
              " -H 'Content-Type: application/json' -d '@" + tmp + "' " + JSON.stringify(server + '/Users/AuthenticateByName')
            const spec = shell.resolve({ command: cmd, timeoutMs: 20000, stdoutMaxBytes: 1048576 })
            const r = await shell.run(spec)
            try { fs.unlinkSync(tmp) } catch (e) {}
            const d = JSON.parse(r && r.stdout ? (r.stdout.text || '{}') : '{}')
            if (!d || !d.AccessToken || !d.User) { json(res, { ok: false, error: 'auth-fail' }); return }
            jf = { server, token: String(d.AccessToken), userId: String(d.User.Id), userName: String(d.User.Name || user) }
            json(res, { ok: true, server, user: jf.userName })
          } catch (e) { json(res, { ok: false, error: 'fail' }) }
        })
      },
    })
    ctx.effect(() => offJfLogin)

    const offJfViews = webServer.register({
      kind: 'exact',
      path: '/ambient-jf/views',
      handler: async (req, res) => {
        if (!jf) { json(res, { ok: false, error: 'no-jf' }); return }
        const r = await jfCall('GET', '/Users/' + encodeURIComponent(jf.userId) + '/Views?api_key=' + encodeURIComponent(jf.token))
        if (!r.ok) { json(res, { ok: false, error: r.error }); return }
        const items = (r.data.Items || []).map((it) => ({ id: String(it.Id), name: String(it.Name || ''), type: String(it.CollectionType || ''), childCount: Number(it.ChildCount || 0) }))
        json(res, { ok: true, items })
      },
    })
    ctx.effect(() => offJfViews)

    const offJfItems = webServer.register({
      kind: 'exact',
      path: '/ambient-jf/items',
      handler: async (req, res) => {
        try {
          if (!jf) { json(res, { ok: false, error: 'no-jf' }); return }
          const u = new URL(req.url || '/', 'http://internal')
          const parent = encodeURIComponent(String(u.searchParams.get('parent') || ''))
          const include = String(u.searchParams.get('include') || 'Movie,Series,Episode')
          const r = await jfCall('GET', '/Users/' + encodeURIComponent(jf.userId) + '/Items?api_key=' + encodeURIComponent(jf.token) +
            '&ParentId=' + parent + '&Recursive=true&IncludeItemTypes=' + include + '&SortBy=SortName&Limit=80&Fields=PrimaryImageAspectRatio')
          if (!r.ok) { json(res, { ok: false, error: r.error }); return }
          const items = (r.data.Items || []).map((it) => ({
            id: String(it.Id),
            name: String(it.Name || ''),
            type: String(it.Type || ''),
            year: it.ProductionYear || null,
            hasImage: !!(it.ImageTags && it.ImageTags.Primary),
          }))
          json(res, { ok: true, items })
        } catch (e) { json(res, { ok: false, error: 'fail' }) }
      },
    })
    ctx.effect(() => offJfItems)

    // Jellyfin 取流地址（带 token 的 HLS master）
    const offJfStream = webServer.register({
      kind: 'exact',
      path: '/ambient-jf/stream',
      handler: async (req, res) => {
        try {
          if (!jf) { json(res, { ok: false, error: 'no-jf' }); return }
          const u = new URL(req.url || '/', 'http://internal')
          const id = String(u.searchParams.get('id') || '')
          if (!id) { json(res, { ok: false, error: 'bad-id' }); return }
          json(res, { ok: true, url: jf.server.replace(/\/+$/, '') + '/Videos/' + encodeURIComponent(id) + '/master.m3u8?MediaSourceId=' + encodeURIComponent(id) + '&api_key=' + encodeURIComponent(jf.token) })
        } catch (e) { json(res, { ok: false, error: 'fail' }) }
      },
    })
    ctx.effect(() => offJfStream)

    // Jellyfin 封面图代理（避免 token 泄露到浏览器 <img>）
    const offJfImg = webServer.register({
      kind: 'prefix',
      path: '/ambient-jf/img',
      handler: async (req, res) => {
        try {
          if (!jf || !shell) { try { res.writeHead(404); res.end() } catch (e) {} return }
          const u = new URL(req.url || '/', 'http://internal')
          const id = String(u.searchParams.get('id') || '')
          const w = Number(u.searchParams.get('w') || '320') || 320
          if (!id) { try { res.writeHead(404); res.end() } catch (e) {} return }
          const url = jf.server.replace(/\/+$/, '') + '/Items/' + encodeURIComponent(id) + '/Images/Primary?maxWidth=' + w + '&quality=80&api_key=' + encodeURIComponent(jf.token)
          const spec = shell.resolve({ command: 'curl -s --max-time 8 -o /tmp/dsh-jf-img.jpg -w "%{http_code}" ' + JSON.stringify(url), timeoutMs: 10000, stdoutMaxBytes: 8192 })
          const r = await shell.run(spec)
          const code = r && r.stdout ? String(r.stdout.text || '').trim() : '000'
          const f = '/tmp/dsh-jf-img.jpg'
          if (code !== '200' || !fs.existsSync(f)) { try { res.writeHead(404); res.end() } catch (e) {} return }
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' })
          fs.createReadStream(f).pipe(res)
        } catch (e) { try { res.writeHead(404); res.end() } catch (e2) {} }
      },
    })
    ctx.effect(() => offJfImg)

    const offFavFolders = webServer.register({
      kind: 'exact',
      path: '/ambient-fav/folders',
      handler: async (req, res) => {
        if (!biliCookieStr) { json(res, { ok: false, error: 'no-cookie' }); return }
        const mid = await getMid()
        if (!mid) { json(res, { ok: false, error: 'no-login' }); return }
        const d = await curlJson('https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=' + mid + '&rid=0', 'https://space.bilibili.com/' + mid + '/favlist')
        if (!d || d.code !== 0) { json(res, { ok: false, error: 'api:' + String(d && d.code) }); return }
        const folders = ((d.data && d.data.list) || []).map((f) => ({ id: String(f.id), title: String(f.title || ''), count: Number(f.media_count || 0), pic: String(f.cover || '') }))
        json(res, { ok: true, mid, folders })
      },
    })
    ctx.effect(() => offFavFolders)

    const offFavList = webServer.register({
      kind: 'exact',
      path: '/ambient-fav/list',
      handler: async (req, res) => {
        try {
          if (!biliCookieStr) { json(res, { ok: false, error: 'no-cookie' }); return }
          const u = new URL(req.url || '/', 'http://internal')
          const mediaId = String(u.searchParams.get('media_id') || '')
          const pn = Number(u.searchParams.get('pn') || '1') || 1
          if (!/^\d+$/.test(mediaId)) { json(res, { ok: false, error: 'bad-id' }); return }
          const q = await wbiSign({ media_id: mediaId, pn, ps: 20, platform: 'web', order: 'mtime' })
          const d = await curlJson('https://api.bilibili.com/x/v3/fav/resource/list?' + q, 'https://www.bilibili.com/medialist/detail/ml' + mediaId)
          if (!d || d.code !== 0) { json(res, { ok: false, error: 'api:' + String(d && d.code) }); return }
          const items = ((d.data && d.data.medias) || []).map((m) => ({
            bvid: String(m.bvid || ''),
            title: String(m.title || ''),
            pic: String(m.cover || ''),
            duration: Number(m.duration || 0),
            up: String((m.upper && m.upper.name) || ''),
          })).filter((x) => x.bvid)
          json(res, { ok: true, items })
        } catch (e) { json(res, { ok: false, error: 'fail' }) }
      },
    })
    ctx.effect(() => offFavList)

    // ---- AI 端点测试 / 模型列表 ----
    const offAiTest = webServer.register({
      kind: 'exact',
      path: '/ambient-ai/test',
      handler: async (req, res) => {
        const u = new URL(req.url || '/', 'http://internal')
        const kind = String(u.searchParams.get('kind') || '')
        const models = kind === 'reason'
          ? await aiModels({ provider: reasonProvider || aiProvider, base: reasonBase || aiBase, key: reasonKey || aiKey })
          : await aiModels()
        json(res, { ok: models.length > 0, models })
      },
    })
    ctx.effect(() => offAiTest)

    // ---- 单条推荐理由生成（客户端流式逐条补，POST {query, item}）----
    const offAiReason = webServer.register({
      kind: 'exact',
      path: '/ambient-ai/reason',
      handler: (req, res) => {
        let body = ''
        req.on('data', (c) => { body += c })
        req.on('end', async () => {
          try {
            const p = JSON.parse(body || '{}')
            const query = String(p.query || '').trim() || '适合做背景的视频'
            const it = p.item || {}
            const title = String(it.title || '')
            const up = String(it.up || '')
            const dur = Number(it.duration || 0)
            if (!reasonEnabled) { json(res, { ok: false, error: 'reason-disabled' }); return }
            const sys = '你是视频推荐助手，为每条视频写一句 15-25 字的推荐理由，说明它为什么适合作为工作/学习的氛围背景视频。只输出理由本身，不要引号、不要前缀。'
            const msg = await aiChat([
              { role: 'system', content: sys },
              { role: 'user', content: '用户需求：' + query + '\n视频：' + (title || '未知') + '（UP:' + (up || '未知') + '，时长' + Math.round(dur / 60) + '分钟）\n请写推荐理由。' },
            ], 256, { provider: reasonProvider || aiProvider, base: reasonBase || aiBase, model: reasonModel || aiModel, key: reasonKey || aiKey })
            const reason = msg ? String(msg).trim().replace(/^["'“”\s]+|["'“”\s]+$/g, '').slice(0, 120) : ''
            json(res, { ok: !!reason, reason })
          } catch (e) { json(res, { ok: false, error: 'fail' }) }
        })
      },
    })
    ctx.effect(() => offAiReason)
    // 最近一次 AI 选卡结果快照（客户端轮询用）
    const offAskState = webServer.register({
      kind: 'exact',
      path: '/ambient-ask/state',
      handler: (req, res) => {
        json(res, { ok: !!askLast, seq: askSeq, cards: askLast ? askLast.cards : null, query: askLast ? askLast.query : '', at: askLast ? askLast.at : 0 })
      },
    })
    ctx.effect(() => offAskState)

    // ---- 浏览器 Cookie 读取 ----
    const offCookieRead = webServer.register({
      kind: 'exact',
      path: '/ambient-cookie/read',
      handler: async (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const browser = String(u.searchParams.get('browser') || '')
          if (browser === 'firefox') {
            const profDir = path.join(os.homedir(), '.mozilla', 'firefox')
            if (!fs.existsSync(profDir)) { json(res, { ok: false, error: 'no-firefox' }); return }
            const dirs = fs.readdirSync(profDir).filter((n) => n.endsWith('.default') || n.endsWith('.default-release'))
            let found = ''
            for (const d of dirs) {
              const f = path.join(profDir, d, 'cookies.sqlite')
              if (fs.existsSync(f)) { found = f; break }
            }
            if (!found) { json(res, { ok: false, error: 'no-firefox-profile' }); return }
            const tmp = path.join(os.tmpdir(), 'ffck-' + Date.now())
            fs.mkdirSync(tmp)
            for (const s of ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm']) {
              const src = path.join(path.dirname(found), s)
              if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(tmp, s)) } catch (e) {} }
            }
            const py = path.join(tmp, 'dump.py')
            fs.writeFileSync(py, '\
import sqlite3, json, sys\n\
db = sqlite3.connect(sys.argv[1])\n\
cur = db.cursor()\n\
out = {}\n\
try:\n\
  cur.execute("SELECT name, value FROM moz_cookies WHERE host_key LIKE \\"%bilibili.com\\" OR host_key LIKE \\"%bili.com\\"")\n\
  for name, value in cur.fetchall():\n\
    if name in ("SESSDATA","bili_jct","DedeUserID","buvid3"): out[name] = value\n\
except Exception as e: pass\n\
db.close()\n\
print(json.dumps(out))\n')
            const spec = shell.resolve({ command: 'python3 ' + JSON.stringify(py) + ' ' + JSON.stringify(path.join(tmp, 'cookies.sqlite')), timeoutMs: 15000, stdoutMaxBytes: 65536 })
            const r = await shell.run(spec)
            let ck = {}
            try { ck = JSON.parse(r && r.stdout ? (r.stdout.text || '{}') : '{}') } catch (e) { ck = {} }
            try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {}
            if (!ck.SESSDATA) { json(res, { ok: false, error: 'no-sessdata', hint: 'Firefox 里没有登录 bilibili，或未找到 cookie' }); return }
            const cookie = ['SESSDATA=' + ck.SESSDATA, ck.bili_jct ? 'bili_jct=' + ck.bili_jct : '', ck.DedeUserID ? 'DedeUserID=' + ck.DedeUserID : '', ck.buvid3 ? 'buvid3=' + ck.buvid3 : ''].filter(Boolean).join('; ')
            biliCookieStr = cookie
            cookieSource = 'firefox'
            json(res, { ok: true, cookie, source: 'firefox', has: Object.keys(ck).join(',') })
          } else if (browser === 'chrome') {
            const base = path.join(os.homedir(), '.config', 'google-chrome')
            if (!fs.existsSync(base)) { json(res, { ok: false, error: 'no-chrome' }); return }
            const profile = fs.existsSync(path.join(base, 'Default')) ? 'Default' : (fs.readdirSync(base).find((n) => n.startsWith('Profile ')) || '')
            const stateP = path.join(base, 'Local State')
            const dbP = path.join(base, profile, 'Cookies')
            if (!fs.existsSync(stateP) || !fs.existsSync(dbP)) { json(res, { ok: false, error: 'no-chrome-profile' }); return }
            const ls = JSON.parse(fs.readFileSync(stateP, 'utf8'))
            const enc = (ls.os_crypt && ls.os_crypt.encrypted_key) ? ls.os_crypt.encrypted_key : ''
            if (!enc) { json(res, { ok: false, error: 'no-key' }); return }
            const buf = Buffer.from(enc, 'base64')
            const blob = buf.subarray(5) // 去 'DPAPI'
            let masterKey = null
            try {
              const iv = Buffer.alloc(16, 0x20)
              const dc = crypto.createDecipheriv('aes-128-cbc', crypto.createHash('sha256').update('peanuts').digest().subarray(0, 16), iv)
              dc.setAutoPadding(false)
              masterKey = Buffer.concat([dc.update(blob), dc.final()])
            } catch (e) { masterKey = null }
            if (!masterKey) { json(res, { ok: false, error: 'key-fail' }); return }
            const tmp = path.join(os.tmpdir(), 'chck-' + Date.now())
            fs.mkdirSync(tmp)
            for (const s of ['Cookies', 'Cookies-wal', 'Cookies-shm']) {
              const src = path.join(path.dirname(dbP), s)
              if (fs.existsSync(src)) { try { fs.copyFileSync(src, path.join(tmp, s)) } catch (e) {} }
            }
            const py = path.join(tmp, 'dump.py')
            fs.writeFileSync(py, '\
import sqlite3, json, sys\n\
db = sqlite3.connect(sys.argv[1])\n\
cur = db.cursor()\n\
out = []\n\
try:\n\
  cur.execute("SELECT name, encrypted_value FROM cookies WHERE host_key LIKE \\"%bilibili.com\\" OR host_key LIKE \\"%bili.com\\"")\n\
  for name, ev in cur.fetchall():\n\
    if name in ("SESSDATA","bili_jct","DedeUserID","buvid3"): out.append([name, ev.hex()])\n\
except Exception as e: pass\n\
db.close()\n\
print(json.dumps(out))\n')
            const spec = shell.resolve({ command: 'python3 ' + JSON.stringify(py) + ' ' + JSON.stringify(path.join(tmp, 'Cookies')), timeoutMs: 15000, stdoutMaxBytes: 262144 })
            const r = await shell.run(spec)
            let rows = []
            try { rows = JSON.parse(r && r.stdout ? (r.stdout.text || '[]') : '[]') } catch (e) { rows = [] }
            try { fs.rmSync(tmp, { recursive: true, force: true }) } catch (e) {}
            const decryptVal = (hex) => {
              try {
                const v = Buffer.from(hex, 'hex')
                if (v.subarray(0, 3).toString() !== 'v10') return null
                const nonce = v.subarray(3, 15)
                const tag = v.subarray(v.length - 16)
                const ct = v.subarray(15, v.length - 16)
                for (const kl of [32, 16]) {
                  try {
                    const d = crypto.createDecipheriv('aes-' + (kl * 8) + '-gcm', masterKey.subarray(0, kl), nonce)
                    d.setAuthTag(tag)
                    const pt = Buffer.concat([d.update(ct), d.final()])
                    return pt.toString('utf8')
                  } catch (e2) { /* try next length */ }
                }
                return null
              } catch (e) { return null }
            }
            const ck = {}
            for (const [name, hex] of rows) {
              const val = decryptVal(hex)
              if (val) ck[name] = val
            }
            if (!ck.SESSDATA) { json(res, { ok: false, error: 'no-sessdata', hint: 'Chrome v20 新加密可能读不了，建议在设置里直接粘贴 Cookie' }); return }
            const cookie = ['SESSDATA=' + ck.SESSDATA, ck.bili_jct ? 'bili_jct=' + ck.bili_jct : '', ck.DedeUserID ? 'DedeUserID=' + ck.DedeUserID : ''].filter(Boolean).join('; ')
            biliCookieStr = cookie
            cookieSource = 'chrome'
            json(res, { ok: true, cookie, source: 'chrome', has: Object.keys(ck).join(',') })
          } else {
            json(res, { ok: false, error: 'bad-browser' })
          }
        } catch (e) { json(res, { ok: false, error: 'fail' }) }
      },
    })
    ctx.effect(() => offCookieRead)
  }

  // ---- 搜索结果挑选（VOD，维持 iframe）----
  function pickResult(srcs) {
    for (const s of srcs) {
      const u = String(s.url || '')
      const b = u.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/)
      if (b) return { site: 'bili', bvid: b[1], title: String(s.title || '') }
    }
    for (const s of srcs) {
      const u = String(s.url || '')
      const y = u.match(/youtube\.com\/watch\?.*?v=([\w-]{6,})/) || u.match(/youtu\.be\/([\w-]{6,})/) || u.match(/youtube\.com\/embed\/([\w-]{6,})/)
      if (y) return { site: 'yt', vid: y[1], title: String(s.title || '') }
    }
    return null
  }
  async function searchBiliApi(kw) {
    if (!shell) return null
    const q = encodeURIComponent(kw)
    const runOnce = async () => {
      const cmd = 'curl -s --max-time 5 -c /tmp/bili_ck.txt -o /dev/null https://www.bilibili.com/ && curl -s --max-time 10 -b /tmp/bili_ck.txt -A "Mozilla/5.0" -H "Referer: https://www.bilibili.com/" "https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + q + '"'
      const spec = shell.resolve({ command: cmd, timeoutMs: 16000, stdoutMaxBytes: 1048576 })
      const r = await shell.run(spec)
      try {
        const data = JSON.parse(r && r.stdout ? (r.stdout.text || '') : '')
        if (data && data.code === 0 && data.data && Array.isArray(data.data.result)) {
          const hit = data.data.result.find((x) => x && typeof x.bvid === 'string' && x.bvid)
          if (hit) return { site: 'bili', bvid: String(hit.bvid), title: String(hit.title || '') }
        }
      } catch (e) { /* retry */ }
      return null
    }
    try {
      const first = await runOnce()
      if (first) return first
      return await runOnce()
    } catch (e) { return null }
  }
  async function searchAnysearch(query) {
    if (!shell) return null
    try {
      const body = JSON.stringify({ query, max_results: 8 })
      const proxyArg = searchProxy ? " -x " + JSON.stringify(searchProxy) : ''
      const cmd = "curl -s --max-time 12" + proxyArg + " -X POST https://api.anysearch.com/v1/search -H \"content-type: application/json\" -d '" + body + "'"
      const spec = shell.resolve({ command: cmd, timeoutMs: 20000, stdoutMaxBytes: 262144 })
      const r = await shell.run(spec)
      const data = JSON.parse(r && r.stdout ? (r.stdout.text || '') : '')
      const results = data && data.data && Array.isArray(data.data.results) ? data.data.results : []
      for (const it of results) {
        const u = String(it.url || '')
        const y = u.match(/youtube\.com\/watch\?.*?v=([\w-]{6,})/) || u.match(/youtu\.be\/([\w-]{6,})/)
        if (y) return { site: 'yt', vid: y[1], title: String(it.title || '') }
        const b = u.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/)
        if (b) return { site: 'bili', bvid: b[1], title: String(it.title || '') }
      }
    } catch (e) { /* ignore */ }
    return null
  }
  const tryWeb = async (q, ms) => {
    if (!web) return null
    let timer = null
    try {
      const res = await Promise.race([
        web.search({ query: q, maxResults: 10 }),
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms || 4000) }),
      ])
      if (!res) return null
      return pickResult(res && res.sources ? res.sources : [])
    } catch (e) { return null } finally { if (timer) clearTimeout(timer) }
  }
  async function searchVideo(kw, mode) {
    if (mode === 'domestic') {
      const b = await searchBiliApi(kw)
      if (b) return b
      const a = await searchAnysearch('bilibili ' + kw)
      if (a) return a
      return await tryWeb('bilibili ' + kw, 1500)
    }
    const a = await searchAnysearch('youtube ' + kw)
    if (a) return a
    return await tryWeb('youtube ' + kw, 2500)
  }
  const withTimeout5 = (p) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
  ])

  // ---- 命令 ----
  if (commands) {
    // ---- AI 标识辅助：/playsearch AI 与 /playsearchw AI 共用 ----
    // 多结果国外搜索（YouTube 优先）
    const tryWebList = async (q, ms) => {
      if (!web) return []
      let timer = null
      try {
        const res = await Promise.race([
          web.search({ query: q, maxResults: 10 }),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms || 4000) }),
        ])
        if (!res || !res.sources) return []
        const out = []
        for (const s of res.sources) {
          const u = String(s.url || '')
          const y = u.match(/youtube\.com\/watch\?.*?v=([\w-]{6,})/) || u.match(/youtu\.be\/([\w-]{6,})/)
          if (y) { out.push({ site: 'yt', vid: y[1], title: String(s.title || '') }); continue }
          const b = u.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/)
          if (b) out.push({ site: 'bili', bvid: b[1], title: String(s.title || '') })
        }
        return out
      } catch (e) { return [] } finally { if (timer) clearTimeout(timer) }
    }
    // AI 从收藏推荐（/playsearch AI <描述>）
    // 流式 AI：AI 选卡（只输出序号，不写理由→快），先出卡；推荐理由由客户端逐条异步补（/ambient-ai/reason）
    async function aiFavRecommend(desc) {
      const items = await loadFavItems(40)
      if (!items.length) return { kind: 'error', text: '无法读取你的B站收藏（Cookie 缺失或失效），请先在设置里读取/粘贴 Cookie' }
      let chosen = items.slice(0, aiCount || 3)
      if (aiEnabled) {
        const list = items.map((it, i) => (i + 1) + '. 「' + it.title + '」 UP:' + it.up + ' 时长:' + String(it.duration) + 's BV:' + it.bvid).join('\n')
        const sys = '你是 B站收藏推荐助手。用户描述需求，从收藏条目里选出最契合的 ' + String(aiCount) + ' 条。只输出 JSON 数组，元素为条目序号（如 [3,7,12]），不要输出其它任何内容。'
        const msg = await aiChat([
          { role: 'system', content: sys },
          { role: 'user', content: '用户需求：' + desc + '\n\n我的收藏：\n' + list + '\n\n请给出最契合的序号数组。' },
        ])
        const m = msg && msg.match(/\[[\s\S]*?\]/)
        if (m) {
          try {
            const picks = JSON.parse(m[0])
            if (Array.isArray(picks)) {
              const sel = picks.map((p) => items[Number(p) - 1]).filter(Boolean).slice(0, aiCount || 3)
              if (sel.length) chosen = sel
            }
          } catch (e) { /* fallback */ }
        }
      }
      const cards = chosen.map((it) => Object.assign({}, it, { reason: '' }))
      const payload = Buffer.from(JSON.stringify(cards)).toString('base64')
      await delay()
      const names = cards.map((c) => '「' + c.title + '」').join('、')
      askSeq += 1; askLast = { seq: askSeq, cards: cards, query: String(desc || ''), at: Date.now() }
      const head = aiEnabled ? '🤖 AI 选卡：' + names : '🤖 选卡 AI 未开启（按原顺序取前 ' + cards.length + ' 条）：' + names
      return { kind: 'success', text: head + '（理由生成中…）\nCARDS:' + payload }
    }
    // AI 国外搜索选片（/playsearchw AI <描述>）
    async function aiForeignPick(desc) {
      const srcs = []
      const a = await searchAnysearch('youtube ' + desc)
      if (a) srcs.push(a)
      const wr = await tryWebList('youtube ' + desc, 2500)
      for (const r of wr) srcs.push(r)
      if (!srcs.length) return { kind: 'error', text: '没搜到国外结果（' + desc + '），换个描述试试' }
      let chosen = srcs.slice(0, aiCount || 3)
      if (aiEnabled && srcs.length > (aiCount || 3)) {
        const list = srcs.map((it, i) => (i + 1) + '. 「' + it.title + '」 ' + (it.site === 'yt' ? 'yt:' + it.vid : it.bvid)).join('\n')
        const sys = '你是 YouTube 视频推荐助手。用户描述需求，从候选里选最契合的 ' + String(aiCount) + ' 条。只输出 JSON 数组，元素为候选序号（如 [2,5]），不要输出其它任何内容。'
        const msg = await aiChat([
          { role: 'system', content: sys },
          { role: 'user', content: '用户需求：' + desc + '\n\n候选：\n' + list + '\n\n请给出最契合的序号数组。' },
        ])
        const m = msg && msg.match(/\[[\s\S]*?\]/)
        if (m) {
          try {
            const picks = JSON.parse(m[0])
            if (Array.isArray(picks)) {
              const sel = picks.map((p) => srcs[Number(p) - 1]).filter(Boolean).slice(0, aiCount || 3)
              if (sel.length) chosen = sel
            }
          } catch (e) { /* fallback */ }
        }
      }
      const cards = chosen.map((it) => Object.assign({}, it, { reason: '' }))
      const payload = Buffer.from(JSON.stringify(cards)).toString('base64')
      await delay()
      const names = cards.map((c) => '「' + c.title + '」').join('、')
      askSeq += 1; askLast = { seq: askSeq, cards: cards, query: String(desc || ''), at: Date.now() }
      const head = aiEnabled ? '🤖 AI 选卡：' + names : '🤖 选卡 AI 未开启（按原顺序取前 ' + cards.length + ' 条）：' + names
      return { kind: 'success', text: head + '（理由生成中…）\nCARDS:' + payload }
    }

    const offUrl = commands.register({
      name: 'playurl',
      description: '播放/切换背景视频：/playurl <链接|本地路径|live:房间号|twitch:频道>',
      input: { hint: '<链接/路径>' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim()
        if (!raw) return { kind: 'error', text: '请提供链接：/playurl <链接>' }
        await delay()
        return { kind: 'success', text: '已切换到：' + raw }
      },
    })
    ctx.effect(() => offUrl)

    const offStop = commands.register({
      name: 'playstop',
      description: '停止背景视频播放',
      handler: async () => {
        await delay()
        return { kind: 'success', text: '已暂停播放' }
      },
    })
    ctx.effect(() => offStop)

    const offHist = commands.register({
      name: 'playhistory',
      description: '查看播放历史（炉石卡牌，拖到中间松手播放）：/playhistory',
      handler: async () => {
        await delay()
        return { kind: 'success', text: '已加载播放历史，拖牌到中间松手播放' }
      },
    })
    ctx.effect(() => offHist)

    const offSearch = commands.register({
      name: 'playsearch',
      description: '国内搜索并播放：/playsearch <关键词>；AI 推荐：/playsearch AI <描述>（从B站收藏选片）',
      input: { hint: '<关键词 或 AI <描述>>' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim()
        if (!raw) return { kind: 'error', text: '请提供关键词：/playsearch <关键词> 或 /playsearch AI <描述>' }
        if (/^ai\s+/i.test(raw)) {
          const desc = raw.replace(/^ai\s+/i, '').trim() || '随便挑一条适合做工作背景的视频'
          return await aiFavRecommend(desc)
        }
        const found = await withTimeout5(searchVideo(raw, 'domestic'))
        if (found && found.timeout) return { kind: 'error', text: '国内搜索超时（>5秒），请重试或直接 /playurl <链接>' }
        if (!found) return { kind: 'error', text: '没搜到国内视频结果（' + raw + '），换个关键词或直接 /playurl <链接>' }
        await delay()
        const label = found.site === 'yt' ? ('yt:' + found.vid) : found.bvid
        return { kind: 'success', text: '已搜索到：' + (found.title || '搜索结果') + '（' + label + '）' }
      },
    })
    ctx.effect(() => offSearch)

    const offSearchW = commands.register({
      name: 'playsearchw',
      description: '外网搜索并播放：/playsearchw <关键词>；AI 选片：/playsearchw AI <描述>（国外结果AI挑选）',
      input: { hint: '<关键词 或 AI <描述>>' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim()
        if (!raw) return { kind: 'error', text: '请提供关键词：/playsearchw <关键词> 或 /playsearchw AI <描述>' }
        if (/^ai\s+/i.test(raw)) {
          const desc = raw.replace(/^ai\s+/i, '').trim() || 'YouTube 上适合做背景的视频'
          return await aiForeignPick(desc)
        }
        const found = await withTimeout5(searchVideo(raw, 'foreign'))
        if (found && found.timeout) return { kind: 'error', text: '外网搜索超时（>5秒），请重试或直接 /playurl <链接>' }
        if (!found) return { kind: 'error', text: '没搜到外网视频结果（' + raw + '），换个关键词或直接 /playurl <链接>' }
        await delay()
        const label = found.site === 'yt' ? ('yt:' + found.vid) : found.bvid
        return { kind: 'success', text: '已搜索到：' + (found.title || '搜索结果') + '（' + label + '）' }
      },
    })
    ctx.effect(() => offSearchW)

  }
}

export { apply }
export const inject = ['commands', 'webServer']