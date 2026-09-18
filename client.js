window.__ModuleLoader__.load({
	id: "dsh-plugin-ambient-video",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const inject = ["slots", "timer"];

		function apply(ctx) {
			const slots = ctx.slots;
			const timer = ctx.timer;

			// ---- 持久化：localStorage（本机浏览器，刷新不丢）----
			const PERSIST_KEY = "dsh.ambient-video.v2";
			function loadPersisted() {
				try {
					const raw = window.localStorage.getItem(PERSIST_KEY);
					if (!raw) return {};
					const p = JSON.parse(raw);
					const out = {};
					for (const k of ["draft","opacity","brightness","blur","mute","loop","proxy","localRoot","cookie","cookieSource","jfServer","jfUser","jfPass","aiEnabled","aiBase","aiModel","aiKey"]) {
						if (typeof p[k] !== "undefined" && p[k] !== null) out[k] = p[k];
					}
					if (typeof out.opacity === "number") out.opacity = Math.min(1, Math.max(0, out.opacity));
					if (typeof out.brightness === "number") out.brightness = Math.min(2, Math.max(0.5, out.brightness));
					if (typeof out.blur === "number") out.blur = Math.min(30, Math.max(0, out.blur));
					return out;
				} catch (e) { return {}; }
			}
			function persist() {
				try {
					window.localStorage.setItem(PERSIST_KEY, JSON.stringify({
						draft: state.draft, opacity: state.opacity, brightness: state.brightness, blur: state.blur,
						mute: state.mute, loop: state.loop, proxy: state.proxy,
						localRoot: state.localRoot, cookie: state.cookie || "", cookieSource: state.cookieSource || "",
						jfServer: state.jfServer, jfUser: state.jfUser, jfPass: state.jfPass || "",
						aiEnabled: !!state.aiEnabled, aiBase: state.aiBase || "", aiModel: state.aiModel || "", aiKey: state.aiKey || "",
					}));
				} catch (e) { /* ignore */ }
			}
			function syncConfig() {
				try {
					fetch("/ambient-config", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ proxy: state.proxy || "", localRoot: state.localRoot || "", cookie: state.cookie || "", cookieSource: state.cookieSource || "", aiEnabled: !!state.aiEnabled, aiBase: state.aiBase || "", aiModel: state.aiModel || "", aiKey: state.aiKey || "" }),
					}).catch(() => {});
				} catch (e) { /* ignore */ }
			}

			// ---- 共享状态 ----
			let state = Object.assign({
				draft: "", src: "", site: "", pic: "", playing: false, nonce: 0,
				opacity: 0.5, brightness: 1.2, blur: 6, mute: false, loop: true,
				proxy: "http://127.0.0.1:7897", localRoot: "", cookie: "", cookieSource: "",
				jfServer: "", jfUser: "", jfPass: "", jfStatus: "",
				aiEnabled: true, aiBase: "http://127.0.0.1:8000/v1", aiModel: "", aiKey: "", aiModels: [], aiStatus: "",
				duration: 0, loopInfo: "", error: "",
				native: false, nativeLoop: false, liveFormat: "", probe: "",
				dirPath: "", dirEntries: null, dirError: "",
				favFolders: [], favItems: [], favSel: "", favInfo: "", favBusy: false,
				jfViews: [], jfItems: [], jfBusy: false, jfItemsInfo: "",
			}, loadPersisted());
			const listeners = new Set();
			const getSnapshot = () => state;
			const subscribe = (fn) => { listeners.add(fn); return () => { try { listeners.delete(fn) } catch (e) {} }; };
			const setState = (patch) => { state = Object.assign({}, state, patch); for (const fn of Array.from(listeners)) { try { fn() } catch (e) {} } persist(); };

			// ---- 循环控制（B站 VOD 已迁原生 <video>，用 loop 属性，无需声卡检测）----
			function clearLoopAll() {}

			function fmtDuration(sec) {
				sec = Math.floor(Number(sec) || 0);
				if (sec >= 3600) { const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60); return h + "小时" + (m ? m + "分" : ""); }
				const m = Math.floor(sec / 60); const s = sec % 60;
				return m > 0 ? (m + "分" + (s ? s + "秒" : "")) : (s + "秒");
			}
			function fmtSize(n) {
				n = Number(n) || 0;
				if (n >= 1073741824) return (n / 1073741824).toFixed(1) + "GB";
				if (n >= 1048576) return (n / 1048576).toFixed(1) + "MB";
				return Math.round(n / 1024) + "KB";
			}

			// ---- hls.js / flv.js 按需加载（本插件同源静态服务）----
			const libLoading = {};
			function ensureLib(name) {
				const globalName = name === "hls" ? "Hls" : "flvjs";
				if (window[globalName]) return Promise.resolve(window[globalName]);
				if (libLoading[name]) return libLoading[name];
				libLoading[name] = new Promise((resolve, reject) => {
					const el = document.createElement("script");
					el.src = "/ambient-vendor/" + name + ".min.js";
					el.onload = () => { const lib = window[globalName]; if (lib) resolve(lib); else reject(new Error("lib-missing")); };
					el.onerror = () => reject(new Error("lib-load-fail"));
					document.head.appendChild(el);
				});
				return libLoading[name];
			}

			// ---- 链接解析 ----
			function parseVideo(text) {
				const t = String(text || "").trim();
				const lm = t.match(/^live:(\d+)$/);
				if (lm) return { site: "live", room: lm[1] };
				const lb = t.match(/live\.bilibili\.com\/(\d+)/);
				if (lb) return { site: "live", room: lb[1] };
				const num = t.match(/^\d{6,10}$/);
				if (num) return { site: "live", room: num[0] };
				const tcm = t.match(/^twitch:([\w-]+)$/i) || t.match(/twitch\.tv\/([\w-]+)/);
				if (tcm) return { site: "twitch", channel: tcm[1] };
				const m = t.match(/\/video\/(BV[0-9A-Za-z]+)/);
				if (m) {
					const p = t.match(/[?&]p=(\d+)/);
					return { site: "bili", bvid: m[1], page: p ? Math.max(1, parseInt(p[1], 10) || 1) : 1 };
				}
				const b = t.match(/^BV[0-9A-Za-z]{10}$/);
				if (b) return { site: "bili", bvid: b[0], page: 1 };
				const y = t.match(/youtube\.com\/watch\?.*?v=([\w-]{6,})/) || t.match(/youtu\.be\/([\w-]{6,})/) || t.match(/youtube\.com\/embed\/([\w-]{6,})/);
				if (y) return { site: "yt", vid: y[1] };
				// 本地文件路径（绝对路径 / ~/ 且是视频扩展名）
				if (t.startsWith("/") || t.startsWith("~/") || t.startsWith("file:")) {
					const loc = t.startsWith("file://") ? decodeURIComponent(t.slice(7)) : t.replace(/^file:/, "");
					if (/\.(mp4|webm|ogg|ogv|mov|m4v|mkv|ts|m2ts|mts|avi|flv)$/i.test(loc)) return { site: "local", path: loc };
				}
				if (t) return { site: "raw", url: t };
				return null;
			}

			function buildSrc(parsed) {
				if (parsed.site === "raw") return parsed.url;
				if (parsed.site === "yt") return "https://www.youtube-nocookie.com/embed/" + parsed.vid + "?autoplay=1&rel=0&loop=1&playlist=" + parsed.vid;
				return "https://player.bilibili.com/player.html?bvid=" + parsed.bvid +
					"&page=" + parsed.page + "&high_quality=1&autoplay=1&mute=" + (state.mute ? 1 : 0);
			}

			function playLocal(p) {
				setState({ src: "", site: "local", native: true, nativeLoop: true, playing: true, nonce: state.nonce + 1, duration: 0, probe: "正在探测文件…", loopInfo: "本地视频（原生解码）", error: "" });
				fetch("/ambient-probe?path=" + encodeURIComponent(p)).then((r) => r.json()).then((r) => {
					if (!r || !r.ok) { setState({ playing: false, src: "", error: "无法访问该文件：" + ((r && r.error) || "") + "（仅允许本地视频根目录内）" }); return; }
					if (r.needsJellyfin) {
						setState({ playing: false, src: "", error: "该视频是 " + String(r.codec || "").toUpperCase() + " 等高规格编码，浏览器解不了。请走 Jellyfin 播放，或换 H.264/AV1 片源。" });
						return;
					}
					const remuxed = r.needsRemux ? "（已自动转封装 mp4）" : "";
					setState({
						src: "/ambient-local/?path=" + encodeURIComponent(r.path),
						native: true, nativeLoop: true, duration: r.duration,
						probe: r.width + "×" + r.height + " · " + String(r.codec || "").toUpperCase() + " · " + fmtDuration(r.duration) + remuxed,
						loopInfo: "本地视频：原生解码循环中" + remuxed,
						error: "",
					});
				}).catch(() => { setState({ playing: false, error: "探测接口异常" }); });
			}

			function playLive(room) {
				setState({ src: "", site: "live", native: true, nativeLoop: false, playing: true, nonce: state.nonce + 1, loopInfo: "正在获取直播流…", error: "" });
				fetch("/ambient-live?room=" + encodeURIComponent(room)).then((r) => r.json()).then((r) => {
					if (!r || !r.ok) { setState({ playing: false, error: "直播流获取失败（" + ((r && r.error) || "") + "）：可能未开播或风控(412)，稍后再试" }); return; }
					setState({ src: r.url, liveFormat: r.format, native: true, nativeLoop: false, loopInfo: "B站直播：" + (r.title || "") + "（" + (r.format === "hls" ? "HLS" : "FLV") + " 原生流）", error: "" });
				}).catch(() => { setState({ playing: false, error: "直播接口异常" }); });
			}

			// B站 VOD 原生播放（playurl 直链 + Host 代理转发 + loop 属性循环）
			function playBiliVod(parsed) {
				setState({ src: "", site: "bili", native: true, nativeLoop: true, playing: true, nonce: state.nonce + 1, duration: 0, loopInfo: "B站VOD：正在获取直链…", error: "" });
				fetch("/ambient-playurl?bvid=" + encodeURIComponent(parsed.bvid) + "&page=" + parsed.page).then((r) => r.json()).then((r) => {
					if (!r || !r.ok) { setState({ playing: false, error: "B站直链获取失败（" + ((r && r.error) || "") + "）：可能被风控，稍后重试" }); return; }
					setState({
						src: "/ambient-proxy?url=" + encodeURIComponent(r.url),
						native: true, nativeLoop: true, duration: r.duration || 0,
						loopInfo: "B站VOD（原生480P循环）：" + (r.title || parsed.bvid),
						error: "",
					});
				}).catch(() => { setState({ playing: false, error: "B站直链接口异常" }); });
			}

			function playTwitch(channel) {
				const parent = window.location.hostname || "localhost";
				setState({
					src: "https://player.twitch.tv/?channel=" + encodeURIComponent(channel) + "&parent=" + encodeURIComponent(parent) + "&autoplay=true&muted=" + (state.mute ? 1 : 0),
					site: "twitch", native: false, playing: true, nonce: state.nonce + 1, loopInfo: "Twitch 直播已嵌入（parent=" + parent + "）", error: "",
				});
			}

			function play(raw) {
				const parsed = parseVideo(raw);
				if (!parsed) { setState({ playing: false, src: "", error: "请先输入链接/路径" }); return; }
				clearLoopAll();
				setState({ draft: String(raw || "").trim(), src: "", site: parsed.site, pic: "", playing: true, native: false, nativeLoop: false, liveFormat: "", nonce: state.nonce + 1, duration: 0, probe: "", error: "" });
				if (parsed.site === "local") { playLocal(parsed.path); return; }
				if (parsed.site === "live") { playLive(parsed.room); return; }
				if (parsed.site === "twitch") { playTwitch(parsed.channel); return; }
				if (parsed.site === "bili") { playBiliVod(parsed); return; }
				const src = buildSrc(parsed);
				setState({
					src,
					site: parsed.site === "raw" ? "raw" : parsed.site,
					playing: true,
					loopInfo: parsed.site === "yt" ? "YouTube 原生循环" : parsed.site === "raw" ? "已按直链嵌入播放" : "正在获取时长…",
				});
			}

			// Jellyfin 播放：Host 组装带 token 的 HLS 地址
			function playJf(id, name) {
				fetch("/ambient-jf/stream?id=" + encodeURIComponent(id)).then((r) => r.json()).then((r) => {
					if (!r || !r.ok) { setState({ playing: false, error: "Jellyfin 取流失败（" + ((r && r.error) || "") + "），请重新登录" }); return; }
					setState({
						src: r.url, site: "jf", native: true, nativeLoop: true, playing: true, nonce: state.nonce + 1,
						loopInfo: "Jellyfin：" + (name || ""), error: "",
					});
				}).catch(() => { setState({ playing: false, error: "Jellyfin 接口异常" }); });
			}

			function pause() {
				clearLoopAll();
				setState({ src: "", playing: false, loopInfo: "已暂停（再次输入链接会从头播放）", error: "" });
			}

			function useStore() {
				const [s, setS] = React.useState(getSnapshot());
				React.useEffect(() => subscribe(() => setS(getSnapshot())), []);
				return s;
			}

			const inputBase = {
				boxSizing: "border-box", minWidth: 0, color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-button-elevated-fill)", border: "0.5px solid var(--dsw-alias-border-l3)",
				borderRadius: 6, outline: "none",
			};
			const iconBtn = {
				flex: "none", width: 26, height: 24, padding: 0, cursor: "pointer",
				color: "var(--dsw-alias-label-secondary)", background: "transparent", border: "none", borderRadius: 6, fontSize: 13, lineHeight: "24px",
			};

			// ---- 原生 <video> 播放器（本地/直播/Jellyfin）----
			function NativePlayer() {
				const s = useStore();
				const ref = React.useRef(null);
				React.useEffect(() => {
					const el = ref.current;
					if (!el || !s.src) return;
					let hls = null, flv = null, disposed = false;
					const doPlay = () => { try { const pr = el.play(); if (pr && pr.catch) pr.catch(() => { el.muted = true; el.play(); setState({ loopInfo: (s.loopInfo || "") + "（自动播放被拦，已静音续播）" }); }); } catch (e) { el.muted = true; el.play(); } };
					if (s.site === "live" && s.liveFormat === "hls") {
						ensureLib("hls").then((Hls) => {
							if (disposed) return;
							if (Hls.isSupported()) { hls = new Hls({ enableWorker: true }); hls.loadSource(s.src); hls.attachMedia(el); hls.on(Hls.Events.ERROR, (ev, data) => { if (data && data.fatal) setState({ error: "直播流错误：" + (data.type || "") }); }); doPlay(); }
							else if (el.canPlayType("application/vnd.apple.mpegurl")) { el.src = s.src; doPlay(); }
						}).catch(() => setState({ error: "hls.js 加载失败" }));
					} else if (s.site === "live" && s.liveFormat === "flv") {
						ensureLib("flv").then((flvjs) => {
							if (disposed) return;
							if (flvjs.isSupported()) {
								flv = flvjs.createPlayer({ type: "flv", url: s.src, isLive: true }, { enableStashBuffer: false });
								flv.attachMediaElement(el); flv.load(); flv.play();
							} else setState({ error: "当前浏览器不支持 FLV 播放" });
						}).catch(() => setState({ error: "flv.js 加载失败" }));
					} else if (s.site === "jf") {
						ensureLib("hls").then((Hls) => {
							if (disposed) return;
							if (Hls.isSupported()) { hls = new Hls({ enableWorker: true }); hls.loadSource(s.src); hls.attachMedia(el); hls.on(Hls.Events.ERROR, (ev, data) => { if (data && data.fatal) setState({ error: "Jellyfin 流错误：" + (data.type || "") }); }); doPlay(); }
							else if (el.canPlayType("application/vnd.apple.mpegurl")) { el.src = s.src; doPlay(); }
						}).catch(() => setState({ error: "hls.js 加载失败" }));
					} else {
						el.src = s.src;
						doPlay();
					}
					const onErr = () => { setState({ error: "视频播放出错（可能编码不支持或网络问题）" }); };
					el.addEventListener("error", onErr);
					return () => {
						disposed = true;
						el.removeEventListener("error", onErr);
						if (hls) { try { hls.destroy() } catch (e) {} }
						if (flv) { try { flv.destroy() } catch (e) {} }
						try { el.pause(); el.removeAttribute("src"); el.load(); } catch (e) {}
					};
				}, [s.src, s.site, s.liveFormat, s.nonce]);
				return React.createElement("video", {
					ref, autoPlay: true, muted: s.mute, loop: s.nativeLoop, playsInline: true, preload: "auto",
					style: { position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", display: "block" },
				});
			}

			// ---- 背景视频层 ----
			const wrapStyle = {
				position: "fixed", inset: 0, overflow: "hidden", pointerEvents: "none",
				opacity: 0, filter: "blur(0px) brightness(1) saturate(1.05)",
			};
			function BgVideo() {
				const s = useStore();
				if (!s.playing) {
					if (!s.src && !s.pic) return null;
					if (!s.src) {
						return React.createElement("div", { style: Object.assign({}, wrapStyle, { opacity: s.opacity, filter: "blur(" + s.blur + "px) brightness(" + s.brightness + ") saturate(1.05)" }) },
							React.createElement("img", { src: s.pic, alt: "", style: { width: "100%", height: "100%", objectFit: "cover", display: "block" } }));
					}
				}
				if (!s.src) return null;
				const style = Object.assign({}, wrapStyle, { opacity: s.opacity, filter: "blur(" + s.blur + "px) brightness(" + s.brightness + ") saturate(1.05)" });
				if (s.native) {
					return React.createElement("div", { style }, React.createElement(NativePlayer));
				}
				return React.createElement("div", { style },
					React.createElement("iframe", {
						key: "ambient-" + s.nonce, src: s.src, title: "背景视频", allow: "autoplay; encrypted-media", tabIndex: -1,
						style: { width: "100%", height: "100%", border: 0, display: "block" },
					})
				);
			}

			// ---- 命令行通用行 ----
			function makeCommandRow(getAction) {
				const handled = new Set();
				return function CommandRow(props) {
					const node = props && props.node;
					const [sawExec, setSawExec] = React.useState(false);
					const [fired, setFired] = React.useState(false);
					React.useEffect(() => {
						if (!node) return;
						if (node.outcome === null) { setSawExec(true); return; }
						if (!sawExec || fired) return;
						if (node.outcome.kind !== "success") return;
						setFired(true);
						if (handled.has(node.commandId)) return;
						handled.add(node.commandId);
						try { getAction(node) } catch (e) { /* ignore */ }
					}, [node, sawExec, fired]);
					const err = node && node.outcome && node.outcome.kind === "error";
					const status = !node ? "" : node.outcome === null ? "⏳ 执行中…" : err ? "❌ " + (node.outcome.text || "失败") : "▶ " + (node.outcome.text || "完成");
					return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 3, padding: "4px 0" } },
						React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontFamily: "var(--ds-font-family-code, monospace)", overflowWrap: "anywhere" } },
							"/" + (node && node.name ? node.name : "") + (node && node.args ? " " + node.args : "")
						),
						React.createElement("div", { style: { fontSize: 12, color: err ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)" } }, status)
					);
				};
			}

			const PlayUrlRow = makeCommandRow((node) => { const u = String(node.args || "").trim(); if (u) play(u); });
			const PlayStopRow = makeCommandRow(() => { pause(); });
			const PlaySearchRow = makeCommandRow((node) => {
				const t = String(node.outcome.text || "");
				const b = t.match(/BV[0-9A-Za-z]{10}/);
				if (b) { play(b[0]); return; }
				const y = t.match(/yt:([\w-]{6,})/);
				if (y) play("https://www.youtube.com/watch?v=" + y[1]);
			});
			// ---- 通用小组件 ----
			const row = { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", width: "100%" };
			const labelStyle = { color: "var(--dsh-alias-label-primary)", fontSize: 13, whiteSpace: "nowrap", flexShrink: 0 };
			const subStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: 12, paddingLeft: 0, marginTop: 3 };
			const sectionTitle = { color: "var(--dsh-alias-label-primary)", fontSize: 14, fontWeight: 600, marginTop: 18, paddingTop: 10, borderTop: "0.5px solid var(--dsh-alias-border-l3)" };

			function cardGrid(items, onClick, getImg, getSub) {
				return React.createElement("div", { style: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, maxWidth: 720 } },
					items.map((it) => React.createElement("div", {
						key: it.id || it.bvid,
						onClick: () => onClick(it),
						style: { cursor: "pointer", border: "0.5px solid var(--dsw-alias-border-l3)", borderRadius: 8, overflow: "hidden", background: "var(--dsw-alias-button-elevated-fill)" },
					},
						getImg && getImg(it) ? React.createElement("img", { src: getImg(it), alt: "", style: { width: "100%", aspectRatio: "16/10", objectFit: "cover", display: "block" } })
							: React.createElement("div", { style: { width: "100%", aspectRatio: "16/10", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--dsw-alias-label-secondary)", fontSize: 11 } }, "无封面"),
						React.createElement("div", { style: { padding: "6px 8px", fontSize: 12, color: "var(--dsw-alias-label-primary)", lineHeight: 1.35 } },
							React.createElement("div", { style: { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, it.title || it.name),
							React.createElement("div", { style: { marginTop: 3, fontSize: 11, color: "var(--dsw-alias-label-secondary)" } }, getSub ? getSub(it) : "")
						)
					))
				);
			}

			// 搜索结果行（普通搜索直接播 / AI 模式 CARDS 卡片）：playsearch 与 playsearchw 共用
			function AskResultRow(props) {
				const node = props && props.node;
				const [cards, setCards] = React.useState(null);
				const [phase, setPhase] = React.useState("idle");
				const fired = React.useRef(false);
				React.useEffect(() => {
					if (!node || fired.current) return;
					if (node.outcome === null) { setPhase("exec"); return; }
					fired.current = true;
					if (node.outcome.kind !== "success") { setPhase("err"); return; }
					const t = String(node.outcome.text || "");
					const c = t.match(/CARDS:([A-Za-z0-9+/=]+)/);
					if (c) {
						try { setCards(JSON.parse(window.atob(c[1]))); setPhase("cards"); return; } catch (e) {}
					}
					setPhase("none");
					const b = t.match(/BV[0-9A-Za-z]{10}/);
					if (b) play(b[0]);
				}, [node]);
				const header = !node ? "" : phase === "exec" ? "⏳ 执行中…" : phase === "err" ? "❌ " + (node.outcome.text || "失败") : phase === "cards" ? "🤖 点卡片播放：" : "▶ " + (node.outcome.text || "完成");
				return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, padding: "4px 0" } },
					React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontFamily: "var(--ds-font-family-code, monospace)", overflowWrap: "anywhere" } },
						"/" + (node && node.name ? node.name : "") + (node && node.args ? " " + node.args : "")),
					React.createElement("div", { style: { fontSize: 12, color: phase === "err" ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)" } }, header),
					cards && cards.length ? cardGrid(cards, (it) => play(it.bvid), (it) => it.pic, (it) => fmtDuration(it.duration) + (it.reason ? " · " + it.reason : "")) : null
				);
			}

			// ---- 设置页 ----
			function BiliSettings() {
				const s = useStore();
				return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 14, maxWidth: 720, padding: "4px 2px" } },
					React.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 15, fontWeight: 600 } }, "氛围背景视频"),
					React.createElement("div", { style: subStyle },
						"命令：/playurl <链接|路径|live:房间号|twitch:频道>、/playsearch <关键词 或 AI <描述>>、/playsearchw <关键词 或 AI <描述>>、/playstop。设置自动保存。"
					),

					React.createElement("div", { style: row },
						React.createElement("input", {
							value: s.draft,
							onChange: (e) => setState({ draft: e.target.value, error: "" }),
							onKeyDown: (e) => { if (e.key === "Enter") play(s.draft) },
							placeholder: "链接 / 本地路径 / live:房间号 / twitch:频道",
							spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 32, padding: "0 10px", fontSize: 13 }),
						}),
						React.createElement("button", {
							onClick: s.playing ? pause : () => play(s.draft),
							style: Object.assign({}, iconBtn, { height: 32, fontSize: 14, padding: "0 12px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, s.playing ? "⏸ 暂停" : "▶ 播放")
					),

					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "搜索代理"),
						React.createElement("input", {
							value: s.proxy,
							onChange: (e) => { setState({ proxy: e.target.value }); syncConfig(); },
							placeholder: "http://127.0.0.1:7897（留空=直连）", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
					),
					React.createElement("div", { style: subStyle }, "供外网搜索/兜底翻墙用（AnySearch）。默认本机 Clash；没有代理就留空。"),

					// ---- 本地视频 ----
					React.createElement("div", { style: sectionTitle }, "🖥 本地视频（原生解码）"),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "根目录"),
						React.createElement("input", {
							value: s.localRoot,
							onChange: (e) => { setState({ localRoot: e.target.value }); syncConfig(); },
							placeholder: "默认 ~/视频（可改，如 /mnt/xxx）", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
					),
					React.createElement("div", { style: row },
						React.createElement("input", {
							value: s.draft,
							onChange: (e) => setState({ draft: e.target.value, error: "" }),
							onKeyDown: (e) => { if (e.key === "Enter" && (s.draft.startsWith("/") || s.draft.startsWith("~/"))) play(s.draft) },
							placeholder: "文件路径：/home/.../xxx.mp4 或 ~/视频/xxx.mkv", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
						React.createElement("button", {
							onClick: () => { const p = s.draft.trim(); if (p) play(p); },
							style: Object.assign({}, iconBtn, { height: 30, fontSize: 13, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "播放"),
					),
					s.probe ? React.createElement("div", { style: subStyle }, "探测结果：" + s.probe) : null,
					React.createElement("div", { style: row },
						React.createElement("button", {
							onClick: () => {
								const dir = s.dirPath || s.localRoot || "";
								fetch("/ambient-list?dir=" + encodeURIComponent(dir)).then((r) => r.json()).then((r) => {
									if (r && r.ok) setState({ dirPath: r.dir, dirEntries: r.entries, dirError: "" });
									else setState({ dirError: "目录不可访问（" + ((r && r.error) || "") + "）" });
								}).catch(() => setState({ dirError: "目录接口异常" }));
							},
							style: Object.assign({}, iconBtn, { height: 28, fontSize: 13, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "📂 浏览目录"),
						s.dirPath ? React.createElement("span", { style: subStyle }, s.dirPath) : null,
					),
					s.dirEntries ? React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 2, maxHeight: 220, overflow: "auto", border: "0.5px solid var(--dsw-alias-border-l3)", borderRadius: 8, padding: 6, fontSize: 12 } },
						s.dirEntries.map((e) => React.createElement("div", {
							key: e.name,
							onClick: () => {
								if (e.isDir) {
									fetch("/ambient-list?dir=" + encodeURIComponent(s.dirPath + "/" + e.name)).then((r) => r.json()).then((r) => {
										if (r && r.ok) setState({ dirPath: r.dir, dirEntries: r.entries, dirError: "" });
									}).catch(() => {});
								} else if (e.video) {
									play(s.dirPath + "/" + e.name);
								}
							},
							style: { cursor: "pointer", padding: "3px 6px", borderRadius: 4, color: e.isDir ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)" },
						}, (e.isDir ? "📁 " : "🎬 ") + e.name + (e.isDir ? "" : "（" + fmtSize(e.size) + "）")))
					) : null,
					s.dirError ? React.createElement("div", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, s.dirError) : null,
					React.createElement("div", { style: subStyle }, "MP4/WebM 直接原生解码；MKV/AVI/FLV 自动 ffmpeg 转封装（不重编码）；HEVC/高规格编码浏览器解不了，请用下方 Jellyfin。"),

					// ---- 直播 ----
					React.createElement("div", { style: sectionTitle }, "📡 直播"),
					React.createElement("div", { style: row },
						React.createElement("input", {
							value: s.draft,
							onChange: (e) => setState({ draft: e.target.value, error: "" }),
							onKeyDown: (e) => {
								if (e.key !== "Enter") return;
								const t = s.draft.trim();
								if (/^\d+$/.test(t)) play("live:" + t);
								else if (/^twitch:/i.test(t) || /twitch\.tv/i.test(t)) play(t);
							},
							placeholder: "B站房间号 / 直播间链接 / twitch:频道名", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
						React.createElement("button", {
							onClick: () => { const t = s.draft.trim(); if (/^\d+$/.test(t)) play("live:" + t); else if (/^twitch:/i.test(t) || /twitch\.tv/i.test(t)) play(t); },
							style: Object.assign({}, iconBtn, { height: 30, fontSize: 13, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "播放"),
					),
					React.createElement("div", { style: subStyle }, "B站直播走原生 FLV/HLS 流（无需登录）；Twitch 走官方嵌入播放器（需要浏览器能翻墙，parent 已自动填）。"),

					// ---- Jellyfin ----
					React.createElement("div", { style: sectionTitle }, "🎞 Jellyfin（高规格视频解码）"),
					React.createElement("div", { style: row },
						React.createElement("input", {
							value: s.jfServer,
							onChange: (e) => setState({ jfServer: e.target.value }),
							placeholder: "服务器地址 http://192.168.0.243:8096", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
					),
					React.createElement("div", { style: row },
						React.createElement("input", {
							value: s.jfUser,
							onChange: (e) => setState({ jfUser: e.target.value }),
							placeholder: "用户名", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
					),
					React.createElement("div", { style: row },
						React.createElement("input", {
							value: s.jfPass,
							onChange: (e) => setState({ jfPass: e.target.value }),
							placeholder: "密码", type: "password", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
						React.createElement("button", {
							onClick: () => {
								if (!s.jfServer || !s.jfUser) { setState({ jfStatus: "请先填服务器地址和用户名" }); return; }
								setState({ jfStatus: "连接中…", jfBusy: true });
								fetch("/ambient-jf/login", {
									method: "POST", headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ server: s.jfServer, user: s.jfUser, pass: s.jfPass || "" }),
								}).then((r) => r.json()).then((r) => {
									if (!r || !r.ok) { setState({ jfStatus: "连接失败：" + ((r && r.error) || ""), jfBusy: false }); return; }
									setState({ jfStatus: "已连接：" + (r.user || s.jfUser), jfBusy: false });
									fetch("/ambient-jf/views").then((rr) => rr.json()).then((rr) => {
										if (rr && rr.ok) setState({ jfViews: rr.items });
									}).catch(() => {});
								}).catch(() => setState({ jfStatus: "连接失败：网络异常", jfBusy: false }));
							},
							disabled: s.jfBusy,
							style: Object.assign({}, iconBtn, { height: 30, fontSize: 13, padding: "0 12px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "连接"),
					),
					s.jfStatus ? React.createElement("div", { style: subStyle }, s.jfStatus) : null,
					s.jfViews.length ? React.createElement("div", { style: row },
						React.createElement("select", {
							value: s.jfItemsInfo.indexOf("|") >= 0 ? s.jfItemsInfo.split("|")[0] : "",
							onChange: (e) => {
								const vid = e.target.value;
								if (!vid) return;
								setState({ jfItemsInfo: vid + "|加载中…", jfBusy: true, jfItems: [] });
								fetch("/ambient-jf/items?parent=" + encodeURIComponent(vid)).then((r) => r.json()).then((r) => {
									if (r && r.ok) setState({ jfItems: r.items, jfItemsInfo: vid + "|共 " + r.items.length + " 条", jfBusy: false });
									else { setState({ jfItemsInfo: vid + "|加载失败", jfBusy: false }); }
								}).catch(() => setState({ jfItemsInfo: vid + "|加载异常", jfBusy: false }));
							},
							style: Object.assign({}, inputBase, { height: 30, flex: 1, padding: "0 8px", fontSize: 12 }),
						},
							React.createElement("option", { value: "" }, "选择媒体库…"),
							s.jfViews.map((v) => React.createElement("option", { key: v.id, value: v.id }, v.name + (v.type ? "（" + v.type + "，" + v.childCount + "）" : "")))
						)
					) : null,
					s.jfItems.length ? React.createElement("div", null,
						cardGrid(s.jfItems, (it) => playJf(it.id, it.name), (it) => "/ambient-jf/img?id=" + encodeURIComponent(it.id) + "&w=320", (it) => (it.type || "") + (it.year ? " · " + it.year : ""))
					) : null,
					React.createElement("div", { style: subStyle }, "点卡片在本插件里原生循环播放（HLS 串流，服务端自动适配转码，HEVC/4K 也能解）。"),

					// ---- AI 推荐 ----
					React.createElement("div", { style: sectionTitle }, "🤖 AI 推荐（/playsearch AI 入口）"),
					React.createElement("label", { style: row },
						React.createElement("input", {
							type: "checkbox", checked: !!s.aiEnabled,
							onChange: (e) => setState({ aiEnabled: e.target.checked }),
						}),
						React.createElement("span", { style: labelStyle }, "启用 AI 推荐（关闭则 AI 模式明确报错）")
					),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "AI 地址"),
						React.createElement("input", {
							value: s.aiBase,
							onChange: (e) => setState({ aiBase: e.target.value }),
							placeholder: "OpenAI 兼容端点，如 http://127.0.0.1:8000/v1", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
					),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "模型"),
						React.createElement("input", {
							value: s.aiModel,
							onChange: (e) => setState({ aiModel: e.target.value }),
							placeholder: "如 Qwen3.5-4B-AWQ：/playsearch AI 用它选片", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
						React.createElement("button", {
							onClick: () => {
								fetch("/ambient-ai/test").then((r) => r.json()).then((r) => {
									if (r && r.ok && r.models.length) { setState({ aiModels: r.models, aiModel: s.aiModel || r.models[0], aiStatus: "已连上 " + r.models.length + " 个模型" }); syncConfig(); }
									else setState({ aiStatus: "连不上 AI，检查地址/密钥" });
								}).catch(() => setState({ aiStatus: "接口异常" }));
							},
							style: Object.assign({}, iconBtn, { height: 30, fontSize: 12, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "🔌 测试/获取模型"),
					),
					s.aiModels.length ? React.createElement("div", { style: row },
						React.createElement("select", {
							value: s.aiModel,
							onChange: (e) => { setState({ aiModel: e.target.value }); syncConfig(); },
							style: Object.assign({}, inputBase, { height: 28, flex: 1, padding: "0 8px", fontSize: 12 }),
						},
							React.createElement("option", { value: "" }, "选择模型…"),
							s.aiModels.map((m) => React.createElement("option", { key: m, value: m }, m))
						)
					) : null,
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "API Key"),
						React.createElement("input", {
							value: s.aiKey,
							onChange: (e) => { setState({ aiKey: e.target.value }); syncConfig(); },
							placeholder: "可选（本地 vLLM 一般不需要）", type: "password", spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
					),
					s.aiStatus ? React.createElement("div", { style: subStyle }, s.aiStatus) : null,
					React.createElement("div", { style: subStyle }, "/playsearch AI <描述>：从B站收藏 AI 选片出卡片；/playsearchw AI <描述>：国外结果 AI 选片。AI 未配置/失败会明确报错。"),

					// ---- B站收藏 ----
					React.createElement("div", { style: sectionTitle }, "⭐ B站收藏推荐"),
					React.createElement("div", { style: row },
						React.createElement("button", {
							onClick: () => {
								fetch("/ambient-cookie/read?browser=firefox").then((r) => r.json()).then((r) => {
									if (r && r.ok) { setState({ cookie: r.cookie, cookieSource: "firefox", favInfo: "已从 Firefox 读取（" + r.has + "）" }); syncConfig(); }
									else setState({ favInfo: "Firefox 读取失败：" + ((r && r.hint) || (r && r.error) || "") });
								}).catch(() => setState({ favInfo: "读取接口异常" }));
							},
							style: Object.assign({}, iconBtn, { height: 28, fontSize: 12, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "🦊 从 Firefox 读"),
						React.createElement("button", {
							onClick: () => {
								fetch("/ambient-cookie/read?browser=chrome").then((r) => r.json()).then((r) => {
									if (r && r.ok) { setState({ cookie: r.cookie, cookieSource: "chrome", favInfo: "已从 Chrome 读取（" + r.has + "）" }); syncConfig(); }
									else setState({ favInfo: "Chrome 读取失败：" + ((r && r.hint) || (r && r.error) || "") });
								}).catch(() => setState({ favInfo: "读取接口异常" }));
							},
							style: Object.assign({}, iconBtn, { height: 28, fontSize: 12, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "🌐 从 Chrome 读"),
						s.cookie ? React.createElement("span", { style: Object.assign({}, subStyle, { paddingLeft: 0 }) }, "Cookie 已就绪（" + (s.cookieSource || "") + "）") : null,
					),
					React.createElement("div", { style: row },
						React.createElement("textarea", {
							value: s.cookie,
							onChange: (e) => { setState({ cookie: e.target.value, cookieSource: "paste" }); syncConfig(); },
							placeholder: "或直接粘贴 Cookie：SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx",
							spellCheck: false, rows: 2,
							style: Object.assign({}, inputBase, { flex: 1, padding: "6px 10px", fontSize: 12, resize: "vertical" }),
						}),
					),
					s.favInfo ? React.createElement("div", { style: subStyle }, s.favInfo) : null,
					React.createElement("div", { style: row },
						React.createElement("button", {
							onClick: () => {
								if (s.favBusy) return;
								setState({ favBusy: true, favInfo: "拉取收藏夹…" });
								fetch("/ambient-fav/folders").then((r) => r.json()).then((r) => {
									if (!r || !r.ok) { setState({ favBusy: false, favInfo: "收藏夹获取失败：" + ((r && r.error) || "") + "（需要有效的 B站 登录 Cookie）" }); return; }
									setState({ favBusy: false, favFolders: r.folders, favInfo: "共 " + r.folders.length + " 个收藏夹（uid " + r.mid + "）" });
								}).catch(() => setState({ favBusy: false, favInfo: "接口异常" }));
							},
							disabled: s.favBusy,
							style: Object.assign({}, iconBtn, { height: 28, fontSize: 12, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "📂 加载收藏夹"),
						s.favFolders.length ? React.createElement("select", {
							value: s.favSel || "",
							onChange: (e) => {
								const fid = e.target.value;
								setState({ favSel: fid, favBusy: true, favInfo: "加载收藏…" });
								fetch("/ambient-fav/list?media_id=" + encodeURIComponent(fid)).then((r) => r.json()).then((r) => {
									if (r && r.ok) { setState({ favBusy: false, favItems: r.items, favInfo: "已加载 " + r.items.length + " 条（点卡片播放）" }); }
									else { setState({ favBusy: false, favInfo: "收藏加载失败：" + ((r && r.error) || "") }); }
								}).catch(() => setState({ favBusy: false, favInfo: "接口异常" }));
							},
							style: Object.assign({}, inputBase, { height: 28, flex: 1, padding: "0 8px", fontSize: 12 }),
						},
							React.createElement("option", { value: "" }, "选择收藏夹…"),
							s.favFolders.map((f) => React.createElement("option", { key: f.id, value: f.id }, f.title + "（" + f.count + "）"))
						) : null,
						s.favItems.length ? React.createElement("button", {
							onClick: () => {
								const lst = s.favItems;
								if (!lst.length) return;
								const pick = lst[Math.floor(Math.random() * lst.length)];
								play(pick.bvid);
								setState({ favInfo: "🎲 随机推荐：" + pick.title });
							},
							style: Object.assign({}, iconBtn, { height: 28, fontSize: 12, padding: "0 10px", borderRadius: 8, border: "0.5px solid var(--dsw-alias-border-l3)", background: "var(--dsw-alias-button-elevated-fill)" }),
						}, "🎲 随机推荐") : null,
					),
					s.favItems.length ? cardGrid(s.favItems, (it) => play(it.bvid), (it) => it.pic, (it) => fmtDuration(it.duration) + (it.up ? " · " + it.up : "")) : null,

					// ---- 显示/循环选项 ----
					React.createElement("div", { style: sectionTitle }, "显示与循环"),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "背景透明度"),
						React.createElement("input", {
							type: "range", min: 0, max: 100, value: Math.round(s.opacity * 100),
							onChange: (e) => setState({ opacity: Number(e.target.value) / 100 }), style: { flex: 1 },
						}),
						React.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, width: 44, textAlign: "right" } }, Math.round(s.opacity * 100) + "%")
					),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "背景亮度"),
						React.createElement("input", {
							type: "range", min: 50, max: 200, step: 5, value: Math.round(s.brightness * 100),
							onChange: (e) => setState({ brightness: Number(e.target.value) / 100 }), style: { flex: 1 },
						}),
						React.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, width: 44, textAlign: "right" } }, Math.round(s.brightness * 100) + "%")
					),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "毛玻璃强度"),
						React.createElement("input", {
							type: "range", min: 0, max: 30, step: 1, value: s.blur,
							onChange: (e) => setState({ blur: Number(e.target.value) }), style: { flex: 1 },
						}),
						React.createElement("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, width: 44, textAlign: "right" } }, s.blur + "px")
					),
					React.createElement("label", { style: row },
						React.createElement("input", {
							type: "checkbox", checked: s.loop,
							onChange: (e) => {
								const loop = e.target.checked;
								setState({ loop });
								if (!loop) { clearLoopAll(); setState({ loopInfo: "" }); }
								else if (state.playing && state.src) play(state.draft);
							},
						}),
						React.createElement("span", { style: labelStyle }, "单曲循环")
					),
					s.loopInfo ? React.createElement("div", { style: subStyle }, "循环状态：" + s.loopInfo) : null,

					React.createElement("label", { style: row },
						React.createElement("input", {
							type: "checkbox", checked: s.mute,
							onChange: (e) => {
								const mute = e.target.checked;
								setState({ mute });
								if (state.playing && state.src) play(state.draft);
							},
						}),
						React.createElement("span", { style: labelStyle }, "静音播放（B站VOD静音时无声卡信号，不循环）")
					),
					s.error ? React.createElement("div", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, s.error) : null
				);
			}

			// 启动同步配置
			syncConfig();

			// ---- 注册 ----
			slots.inject("shell.overlay", () => slots.register(
				{ name: "shell.overlay", id: "bilibili-bg", order: 100, label: "背景视频" },
				() => React.createElement(BgVideo)
			));
			slots.inject("settings.section", () => slots.register(
				{ name: "settings.section", id: "bilibili-bg", order: 50, label: "背景视频" },
				() => React.createElement(BiliSettings)
			));
			slots.inject("conversation.chat.commandview", () => slots.register(
				{ name: "conversation.chat.commandview", key: "playurl" },
				(props) => React.createElement(PlayUrlRow, { node: props && props.node })
			));
			slots.inject("conversation.chat.commandview", () => slots.register(
				{ name: "conversation.chat.commandview", key: "playstop" },
				(props) => React.createElement(PlayStopRow, { node: props && props.node })
			));
			slots.inject("conversation.chat.commandview", () => slots.register(
				{ name: "conversation.chat.commandview", key: "playsearch" },
				(props) => React.createElement(AskResultRow, { node: props && props.node })
			));
			slots.inject("conversation.chat.commandview", () => slots.register(
				{ name: "conversation.chat.commandview", key: "playsearchw" },
				(props) => React.createElement(AskResultRow, { node: props && props.node })
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});