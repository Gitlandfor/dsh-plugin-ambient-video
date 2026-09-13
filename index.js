// dsh-plugin-ambient-video — Bilibili/YouTube 氛围背景视频（持久版，随 DSH 一起启动）
// Host 半：/playurl /playstop /playsearch(国内) /playsearchw(外网) 命令 + /ambient-info/ + /ambient-audio-state + /ambient-config 路由
function apply(ctx) {
  const commands = ctx.get('commands')
  const webServer = ctx.get('webServer')
  const web = ctx.get('web')
  const shell = ctx.get('shell')
  const timer = ctx.get('timer')

  // 搜索代理（AnySearch 走它翻墙）；客户端设置页可改并同步到这里，留空=直连
  let searchProxy = 'http://127.0.0.1:7897'

  if (webServer) {
    // 配置同步：POST /ambient-config {"proxy":"http://…"}（留空=直连）
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
            const proxy = String(p.proxy || '').trim()
            searchProxy = proxy
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: true, proxy: searchProxy }))
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ ok: false }))
          }
        })
      },
    })
    ctx.effect(() => offCfg)

    // 查询视频时长（秒）?bvid=BV…&page=1 → { duration, title, via }
    const offInfo = webServer.register({
      kind: 'prefix',
      path: '/ambient-info/',
      handler: async (req, res) => {
        const json = (obj) => {
          try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) } catch (e) {}
        }
        try {
          const u = new URL(req.url || '/', 'http://internal')
          const bvid = String(u.searchParams.get('bvid') || '')
          const page = Number(u.searchParams.get('page') || '1') || 1
          if (!/^BV[0-9A-Za-z]+$/.test(bvid)) { json({ duration: 0, error: 'bad-bvid' }); return }
          const apiUrl = 'https://api.bilibili.com/x/web-interface/view?bvid=' + encodeURIComponent(bvid)
          let text = ''
          let via = ''
          if (web) {
            try {
              const r = await web.fetch({ url: apiUrl })
              text = r && r.body ? String(r.body.content || '') : ''
              via = 'web'
            } catch (e) { text = '' }
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
          if (!data || data.code !== 0 || !data.data) { json({ duration: 0, error: 'api:' + (data ? String(data.code) : 'empty') }); return }
          const d = data.data
          let duration = Number(d.duration) || 0
          if (page > 1 && Array.isArray(d.pages)) {
            const pg = d.pages.find((x) => Number(x.page) === page)
            if (pg && Number(pg.duration)) duration = Number(pg.duration)
          }
          json({ duration, title: String(d.title || ''), pic: String(d.pic || ''), via })
        } catch (e) {
          json({ duration: 0, error: 'parse-fail' })
        }
      },
    })
    ctx.effect(() => offInfo)

    // ---- 声卡状态驱动循环：/ambient-audio-state ----
    // 客户端轮询此路由；Host 每次跑 pactl 检测 Chrome 音频流（有声=在播），
    // "有声→无声"跳变 = 视频播完/停止 → 返回递增 restart 序号，客户端据此重挂重播。
    // 重挂后持续无声（自动播放被浏览器拦）→ 8 秒后自动重试，最多 2 次。
    let audioWas = false
    let restartSeq = 0
    let lastSeqAt = 0
    let retries = 0
    const offAudioState = webServer.register({
      kind: 'exact',
      path: '/ambient-audio-state',
      handler: async (req, res) => {
        const json = (obj) => {
          try { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) } catch (e) {}
        }
        let playing = false
        if (shell) {
          try {
            const spec = shell.resolve({ command: 'pactl list sink-inputs 2>/dev/null | grep -i "application.name" | grep -iE "chrom|Google Chrome"', timeoutMs: 5000, stdoutMaxBytes: 16384 })
            const r = await shell.run(spec)
            playing = !!(r && r.stdout && r.stdout.text && r.stdout.text.trim())
          } catch (e) { /* 检测失败视为无声 */ }
        }
        const now = Date.now()
        if (playing) {
          audioWas = true
          retries = 0
        } else if (!playing && audioWas) {
          // 有声→无声：视频播完/停止 → 请求重挂
          audioWas = false
          restartSeq += 1
          lastSeqAt = now
          retries = 0
        } else if (!playing && restartSeq > 0 && now - lastSeqAt > 8000 && retries < 2) {
          // 重挂后仍无声（自动播放被拦）→ 再重试
          restartSeq += 1
          retries += 1
          lastSeqAt = now
        }
        json({ restart: restartSeq, audio: playing })
      },
    })
    ctx.effect(() => offAudioState)
  }

  // 从搜索结果里挑出可播放的视频（bilibili 或 youtube）
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

  // 官方 B 站搜索 API（直连 + cookie 预热，仅 bilibili；412 风控自动重试一次）
  async function searchBiliApi(kw) {
    if (!shell) return null
    const q = encodeURIComponent(kw)
    const runOnce = async () => {
      // cookie 预热与搜索放同一条命令（bwrap 的 /tmp 每次独立，分两条会丢 cookie）
      const cmd = 'curl -s --max-time 5 -c /tmp/bili_ck.txt -o /dev/null https://www.bilibili.com/ && curl -s --max-time 10 -b /tmp/bili_ck.txt -A "Mozilla/5.0" -H "Referer: https://www.bilibili.com/" "https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=' + q + '"'
      const spec = shell.resolve({ command: cmd, timeoutMs: 16000, stdoutMaxBytes: 1048576 })
      const r = await shell.run(spec)
      try {
        const data = JSON.parse(r && r.stdout ? (r.stdout.text || '') : '')
        if (data && data.code === 0 && data.data && Array.isArray(data.data.result)) {
          const hit = data.data.result.find((x) => x && typeof x.bvid === 'string' && x.bvid)
          if (hit) return { site: 'bili', bvid: String(hit.bvid), title: String(hit.title || '') }
        }
      } catch (e) { /* 解析失败走重试 */ }
      return null
    }
    try {
      const first = await runOnce()
      if (first) return first
      // 412/空结果 → 换新 cookie 重试一次
      return await runOnce()
    } catch (e) { return null }
  }

  // AnySearch（free-search 内置引擎；走可配置代理 searchProxy，能出油管/B站链接）
  async function searchAnysearch(query) {
    if (!shell) return null
    try {
      const body = JSON.stringify({ query, max_results: 8 })
      // body 必须用单引号包裹，否则 bash 拆坏参数（-d 收不到 JSON，还会等 stdin 卡住）
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
    } catch (e) { /* 忽略 */ }
    return null
  }

  // 多源搜索：mode='domestic' 国内（B 站官方 API 优先含 412 重试，web.search 兜底，整体 5 秒硬超时）；
  // mode='foreign' 外网（油管优先，走代理，同样 5 秒硬超时）
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
      // 国内：官方 API（~0.5s，412 自动重试）→ AnySearch（代理，专兜 412）→ Bing（短超时收尾）
      const b = await searchBiliApi(kw)
      if (b) return b
      const a = await searchAnysearch('bilibili ' + kw)
      if (a) return a
      return await tryWeb('bilibili ' + kw, 1500)
    }
    // 外网：AnySearch（代理）优先，web.search（2.5s 护栏）兜底，整体 <5s
    const a = await searchAnysearch('youtube ' + kw)
    if (a) return a
    return await tryWeb('youtube ' + kw, 2500)
  }

  // 5 秒硬超时包装：超时返回 {timeout:true}
  const withTimeout5 = (p) => Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 5000)),
  ])

  const delay = async () => { if (timer) { try { await timer.timeout(300) } catch (e) {} } }

  if (commands) {
    const offUrl = commands.register({
      name: 'playurl',
      description: '播放/切换背景视频：/playurl <任意视频/网页链接>',
      input: { hint: '<任意链接>' },
      handler: async (invocation) => {
        const raw = String(invocation.rawInput || '').trim()
        if (!raw) return { kind: 'error', text: '请提供链接：/playurl <任意视频/网页链接>' }
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

    const offSearch = commands.register({
      name: 'playsearch',
      description: '国内搜索（B站优先）并播放第一个结果：/playsearch <关键词>',
      input: { hint: '<关键词>' },
      handler: async (invocation) => {
        const kw = String(invocation.rawInput || '').trim()
        if (!kw) return { kind: 'error', text: '请提供搜索关键词：/playsearch <关键词>' }
        const found = await withTimeout5(searchVideo(kw, 'domestic'))
        if (found && found.timeout) return { kind: 'error', text: '国内搜索超时（>5秒），请重试或直接 /playurl <链接>' }
        if (!found) return { kind: 'error', text: '没搜到国内视频结果（' + kw + '），换个关键词或直接 /playurl <链接>' }
        await delay()
        const label = found.site === 'yt' ? ('yt:' + found.vid) : found.bvid
        return { kind: 'success', text: '已搜索到：' + (found.title || '搜索结果') + '（' + label + '）' }
      },
    })
    ctx.effect(() => offSearch)

    const offSearchW = commands.register({
      name: 'playsearchw',
      description: '外网搜索（油管优先，走代理）并播放第一个结果：/playsearchw <关键词>',
      input: { hint: '<关键词>' },
      handler: async (invocation) => {
        const kw = String(invocation.rawInput || '').trim()
        if (!kw) return { kind: 'error', text: '请提供搜索关键词：/playsearchw <关键词>' }
        const found = await withTimeout5(searchVideo(kw, 'foreign'))
        if (found && found.timeout) return { kind: 'error', text: '外网搜索超时（>5秒），请重试或直接 /playurl <链接>' }
        if (!found) return { kind: 'error', text: '没搜到外网视频结果（' + kw + '），换个关键词或直接 /playurl <链接>' }
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
