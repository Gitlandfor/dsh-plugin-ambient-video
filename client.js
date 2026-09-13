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
			const PERSIST_KEY = "dsh.ambient-video.v1";
			function loadPersisted() {
				try {
					const raw = window.localStorage.getItem(PERSIST_KEY);
					if (!raw) return {};
					const p = JSON.parse(raw);
					const out = {};
					if (typeof p.draft === "string") out.draft = p.draft;
					if (typeof p.opacity === "number") out.opacity = Math.min(1, Math.max(0, p.opacity));
					if (typeof p.brightness === "number") out.brightness = Math.min(2, Math.max(0.5, p.brightness));
					if (typeof p.blur === "number") out.blur = Math.min(30, Math.max(0, p.blur));
					if (typeof p.danmaku === "boolean") out.danmaku = p.danmaku;
					if (typeof p.mute === "boolean") out.mute = p.mute;
					if (typeof p.loop === "boolean") out.loop = p.loop;
					if (typeof p.proxy === "string") out.proxy = p.proxy;
					return out;
				} catch (e) { return {}; }
			}
			function persist() {
				try {
					window.localStorage.setItem(PERSIST_KEY, JSON.stringify({
						draft: state.draft,
						opacity: state.opacity,
						brightness: state.brightness,
						blur: state.blur,
						danmaku: state.danmaku,
						mute: state.mute,
						loop: state.loop,
						proxy: state.proxy,
					}));
				} catch (e) { /* 忽略持久化失败 */ }
			}
			// 代理配置同步给 Host（搜索用）
			function syncProxy() {
				try {
					fetch("/ambient-config", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ proxy: state.proxy || "" }),
					}).catch(() => {});
				} catch (e) { /* 忽略 */ }
			}

			// ---- 共享状态（含持久化配置）----
			let state = Object.assign({
				draft: "",
				src: "",
				site: "",
				pic: "",
				playing: false,
				nonce: 0,
				opacity: 0.5,
				brightness: 1.2,
				blur: 6,
				danmaku: false,
				mute: false,
				loop: true,
				proxy: "http://127.0.0.1:7897",
				duration: 0,
				loopInfo: "",
				error: "",
			}, loadPersisted());
			const listeners = new Set();
			const getSnapshot = () => state;
			const subscribe = (fn) => { listeners.add(fn); return () => { try { listeners.delete(fn) } catch (e) {} }; };
			const setState = (patch) => { state = Object.assign({}, state, patch); for (const fn of Array.from(listeners)) { try { fn() } catch (e) {} } persist(); };

			// ---- 单曲循环：B站只走"声卡状态"驱动（Host 检测音频停止 → 重挂）；YouTube 原生 loop ----
			// ---- 声卡状态轮询（Host /ambient-audio-state）：restart 序号变化 → 重挂 ----
			let audioPollDispose = null
			let seenSeq = 0
			function stopAudioLoop() {
				if (audioPollDispose) { try { audioPollDispose() } catch (e) {} audioPollDispose = null }
			}
			function startAudioLoop() {
				stopAudioLoop()
				if (!state.loop) return
				if (!state.playing || !state.src) return
				if (state.site !== "bili") { setState({ loopInfo: "非B站视频：循环由播放器原生处理" }); return }
				if (state.mute) { setState({ loopInfo: "静音模式：无声卡信号，不循环（需带声音才走声卡循环）" }); return }
				setState({ loopInfo: "声卡循环：轮询中…（播完自动重播）" })
				let first = true
				const poll = () => {
					fetch("/ambient-audio-state").then((r) => r.json()).then((d) => {
						const seq = d && typeof d.restart === "number" ? d.restart : 0
						if (first) { seenSeq = seq; first = false; return }   // 首轮同步，吸收暂停期间的旧信号
						if (seq > 0 && seq !== seenSeq) {
							seenSeq = seq
							if (state.playing && state.src) setState({ nonce: state.nonce + 1, loopInfo: "声卡检测：已重播" })
						}
					}).catch(() => {})
				}
				poll()
				if (timer) audioPollDispose = timer.interval(poll, 800)
			}
			function clearLoopAll() {
				stopAudioLoop()
			}
			if (typeof ctx.effect === "function") ctx.effect(() => () => { clearLoopAll() });

			function fmtDuration(sec) {
				const m = Math.floor(sec / 60);
				const s = sec % 60;
				return m > 0 ? (m + "分" + (s ? s + "秒" : "")) : (s + "秒");
			}

			// ---- 链接解析：Bilibili 或 YouTube ----
			function parseVideo(text) {
				const t = String(text || "").trim();
				const m = t.match(/\/video\/(BV[0-9A-Za-z]+)/);
				if (m) {
					const p = t.match(/[?&]p=(\d+)/);
					return { site: "bili", bvid: m[1], page: p ? Math.max(1, parseInt(p[1], 10) || 1) : 1 };
				}
				const b = t.match(/^BV[0-9A-Za-z]{10}$/);
				if (b) return { site: "bili", bvid: b[0], page: 1 };
				const y = t.match(/youtube\.com\/watch\?.*?v=([\w-]{6,})/) || t.match(/youtu\.be\/([\w-]{6,})/) || t.match(/youtube\.com\/embed\/([\w-]{6,})/);
				if (y) return { site: "yt", vid: y[1] };
				// 其它链接不拦：直接按原始链接嵌入 iframe（能不能播取决于对方站点是否允许被嵌入）
				return t ? { site: "raw", url: t } : null;
			}

			function buildSrc(parsed) {
				if (parsed.site === "raw") return parsed.url;
				if (parsed.site === "yt") {
					return "https://www.youtube-nocookie.com/embed/" + parsed.vid + "?autoplay=1&rel=0&loop=1&playlist=" + parsed.vid;
				}
				return "https://player.bilibili.com/player.html?bvid=" + parsed.bvid +
					"&page=" + parsed.page + "&high_quality=1&autoplay=1&mute=" + (state.mute ? 1 : 0) +
					"&danmaku=" + (state.danmaku ? 1 : 0);
			}

			function fetchDuration(parsed) {
				return fetch("/ambient-info/?bvid=" + encodeURIComponent(parsed.bvid) + "&page=" + parsed.page)
					.then((r) => r.json())
					.then((r) => {
						const duration = r && typeof r.duration === "number" ? r.duration : 0;
						const via = r && r.via ? r.via : "";
						const err = r && r.error ? r.error : "";
						let info;
						if (err) info = "时长获取失败（" + err + "），改用声卡循环";
						else if (duration > 0) info = "时长 " + fmtDuration(duration) + (via ? "（" + via + "）" : "") + "，循环就绪";
						else info = "时长获取失败，改用声卡循环";
						setState({ duration, loopInfo: info, pic: r && r.pic ? String(r.pic) : state.pic });
						// B站循环只走声卡状态驱动（startAudioLoop 内部处理 site/mute 并显示原因）
						if (state.playing && state.loop) startAudioLoop()
					})
					.catch((e) => {
						setState({ duration: 0, loopInfo: "时长接口异常，改用声卡循环" });
						if (state.playing && state.loop && state.site === "bili" && !state.mute) startAudioLoop()
					});
			}

			function play(raw) {
				const parsed = parseVideo(raw);
				if (!parsed) {
					setState({ playing: false, src: "", error: "请先输入链接" });
					return;
				}
				clearLoopAll();
				seenSeq = 0
				setState({ draft: String(raw || "").trim(), src: buildSrc(parsed), site: parsed.site, pic: "", playing: true, nonce: state.nonce + 1, duration: 0, loopInfo: parsed.site === "yt" ? "YouTube 原生循环" : parsed.site === "raw" ? "已按直链嵌入播放" : "正在获取时长…", error: "" });
				if (parsed.site === "bili") fetchDuration(parsed);
			}

			// ---- 暂停：停止声音、保留视频状态（封面画面），再次输入链接即播放 ----
			function pause() {
				clearLoopAll();
				seenSeq = 0
				setState({ playing: false, loopInfo: "已暂停（再次输入链接会从头播放）", error: "" });
			}

			function useStore() {
				const [s, setS] = React.useState(getSnapshot());
				React.useEffect(() => subscribe(() => setS(getSnapshot())), []);
				return s;
			}

			const inputBase = {
				boxSizing: "border-box",
				minWidth: 0,
				color: "var(--dsw-alias-label-primary)",
				background: "var(--dsw-alias-button-elevated-fill)",
				border: "0.5px solid var(--dsw-alias-border-l3)",
				borderRadius: 6,
				outline: "none",
			};
			const iconBtn = {
				flex: "none",
				width: 26,
				height: 24,
				padding: 0,
				cursor: "pointer",
				color: "var(--dsw-alias-label-secondary)",
				background: "transparent",
				border: "none",
				borderRadius: 6,
				fontSize: 13,
				lineHeight: "24px",
			};

			// ---- 背景视频层 ----
			function BgVideo() {
				const s = useStore();
				if (!s.playing) {
					if (!s.src || !s.pic) return null;
					return React.createElement("div", {
						style: {
							position: "fixed",
							inset: 0,
							overflow: "hidden",
							pointerEvents: "none",
							opacity: s.opacity,
							filter: "blur(" + s.blur + "px) brightness(" + s.brightness + ") saturate(1.05)",
						},
					}, React.createElement("img", {
						src: s.pic,
						alt: "",
						style: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
					}));
				}
				if (!s.src) return null;
				return React.createElement("div", {
					style: {
						position: "fixed",
						inset: 0,
						overflow: "hidden",
						pointerEvents: "none",
						opacity: s.opacity,
						filter: "blur(" + s.blur + "px) brightness(" + s.brightness + ") saturate(1.05)",
					},
				},
					React.createElement("iframe", {
						key: "ambient-" + s.nonce,
						src: s.src,
						title: "背景视频",
						allow: "autoplay; encrypted-media",
						tabIndex: -1,
						style: { width: "120vw", height: "calc(67.5vw + 45vh)", marginLeft: "-10vw", marginTop: "-22.5vh", border: 0, display: "block" },
					})
				);
			}

			// ---- 命令行通用行：执行中→已落定 跳变触发一次动作（回放不误触发）----
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
						try { getAction(node) } catch (e) { /* 动作失败不抛 */ }
					}, [node, sawExec, fired]);
					const err = node && node.outcome && node.outcome.kind === "error";
					const status = !node ? "" : node.outcome === null ? "⏳ 执行中…" : err ? "❌ " + (node.outcome.text || "失败") : "▶ " + (node.outcome.text || "完成");
					return React.createElement("div", {
						style: { display: "flex", flexDirection: "column", gap: 3, padding: "4px 0" },
					},
						React.createElement("div", { style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", fontFamily: "var(--ds-font-family-code, monospace)", overflowWrap: "anywhere" } },
							"/" + (node && node.name ? node.name : "") + (node && node.args ? " " + node.args : "")
						),
						React.createElement("div", { style: { fontSize: 12, color: err ? "var(--dsw-alias-state-error-primary)" : "var(--dsw-alias-label-secondary)" } }, status)
					);
				};
			}

			const PlayUrlRow = makeCommandRow((node) => {
				const u = String(node.args || "").trim();
				if (u) play(u);
			});
			const PlayStopRow = makeCommandRow(() => { pause(); });
			const PlaySearchRow = makeCommandRow((node) => {
				const t = String(node.outcome.text || "");
				const b = t.match(/BV[0-9A-Za-z]{10}/);
				if (b) { play(b[0]); return; }
				const y = t.match(/yt:([\w-]{6,})/);
				if (y) play("https://www.youtube.com/watch?v=" + y[1]);
			});

			// ---- 设置页 ----
			function BiliSettings() {
				const s = useStore();
				const row = { display: "flex", alignItems: "center", gap: 12 };
				const labelStyle = { color: "var(--dsw-alias-label-primary)", fontSize: 13, whiteSpace: "nowrap" };
				const valueStyle = { color: "var(--dsw-alias-label-secondary)", fontSize: 12, width: 44, textAlign: "right" };
				return React.createElement("div", {
					style: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 560, padding: "4px 2px" },
				},
					React.createElement("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: 15, fontWeight: 600 } }, "氛围背景视频"),
					React.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 13 } },
						"毛玻璃背景：视频铺满全屏。命令：/playurl <任意链接>、/playstop、/playsearch <关键词>（国内B站）、/playsearchw <关键词>（外网）。设置自动保存。"
					),
					React.createElement("div", { style: row },
						React.createElement("input", {
							value: s.draft,
							onChange: (e) => setState({ draft: e.target.value, error: "" }),
							onKeyDown: (e) => { if (e.key === "Enter") play(s.draft) },
							placeholder: "粘贴 Bilibili/YouTube 链接（或 BV 号），回车播放",
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
							onChange: (e) => { setState({ proxy: e.target.value }); syncProxy(); },
							placeholder: "http://127.0.0.1:7897（留空=直连）",
							spellCheck: false,
							style: Object.assign({}, inputBase, { flex: 1, height: 30, padding: "0 10px", fontSize: 12 }),
						}),
					),
					React.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, paddingLeft: 22 } },
						"供外网搜索/兜底翻墙用（AnySearch）。默认本机 Clash；没有代理就留空，国内搜索仍可用。"
					),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "背景透明度"),
						React.createElement("input", {
							type: "range", min: 0, max: 100,
							value: Math.round(s.opacity * 100),
							onChange: (e) => setState({ opacity: Number(e.target.value) / 100 }),
							style: { flex: 1 },
						}),
						React.createElement("span", { style: valueStyle }, Math.round(s.opacity * 100) + "%")
					),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "背景亮度"),
						React.createElement("input", {
							type: "range", min: 50, max: 200, step: 5,
							value: Math.round(s.brightness * 100),
							onChange: (e) => setState({ brightness: Number(e.target.value) / 100 }),
							style: { flex: 1 },
						}),
						React.createElement("span", { style: valueStyle }, Math.round(s.brightness * 100) + "%")
					),
					React.createElement("div", { style: row },
						React.createElement("span", { style: labelStyle }, "毛玻璃强度"),
						React.createElement("input", {
							type: "range", min: 0, max: 30, step: 1,
							value: s.blur,
							onChange: (e) => setState({ blur: Number(e.target.value) }),
							style: { flex: 1 },
						}),
						React.createElement("span", { style: valueStyle }, s.blur + "px")
					),
					React.createElement("label", { style: row },
						React.createElement("input", {
							type: "checkbox",
							checked: s.loop,
							onChange: (e) => {
								const loop = e.target.checked;
								setState({ loop });
								if (!loop) { clearLoopAll(); seenSeq = 0; setState({ loopInfo: "" }); }
								else if (state.playing && state.src) play(state.draft);
							},
						}),
						React.createElement("span", { style: labelStyle }, "单曲循环（声卡检测）")
					),
					s.loopInfo ? React.createElement("div", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, paddingLeft: 22 } }, "循环状态：" + s.loopInfo) : null,
					React.createElement("label", { style: row },
						React.createElement("input", {
							type: "checkbox",
							checked: s.danmaku,
							onChange: (e) => {
								const danmaku = e.target.checked;
								setState({ danmaku });
								if (state.playing && state.src) play(state.draft);
							},
						}),
						React.createElement("span", { style: labelStyle }, "显示弹幕（仅B站）")
					),
					React.createElement("label", { style: row },
						React.createElement("input", {
							type: "checkbox",
							checked: s.mute,
							onChange: (e) => {
								const mute = e.target.checked;
								setState({ mute });
								if (state.playing && state.src) play(state.draft);
							},
						}),
						React.createElement("span", { style: labelStyle }, "静音播放（静音时无声卡信号，不循环）")
					),
					s.error ? React.createElement("div", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 } }, s.error) : null
				);
			}

			// 启动时把代理配置同步给 Host
			syncProxy();

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
				(props) => React.createElement(PlaySearchRow, { node: props && props.node })
			));
			slots.inject("conversation.chat.commandview", () => slots.register(
				{ name: "conversation.chat.commandview", key: "playsearchw" },
				(props) => React.createElement(PlaySearchRow, { node: props && props.node })
			));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
