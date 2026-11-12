window.__ModuleLoader__.load({
	id: "@local/vbw-client-ui",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let _deepseek_ai_dsh_client_store = require("@deepseek-ai/dsh-client-store");
		//#region vbw-client-ui/client/constants
		/** Plugin identity and Slot dispatch key. */
		const PLUGIN_ID = "@local/vbw-client-ui";
		const TAB_ID = "vbw.browser";
		/** Locale namespace and default broker UI location (specs/broker-api.md). */
		const NAMESPACE = "vbwClientUi";
		const DEFAULT_UI_URL = "http://127.0.0.1:8931/ui";
		/** Start command documented in _vbw\AGENTS.md. */
		const START_COMMAND = "cd _vbw\\broker && node src/server.mjs";
		/** Persisted client store key. */
		const STORE_KEY = "vbw.client-ui.v1";
		//#endregion
		//#region vbw-client-ui/client/locales
		const en = {
			"type.label": "VBW Browser",
			"guide.title": "Open VBW",
			"guide.description": "Open the Visual Browser workspace",
			"status.checking": "Checking broker…",
			"offline.title": "VBW broker is offline",
			"offline.hint": "The Visual Browser UI needs the local VBW broker. Start it, then this tab reconnects automatically:",
			"offline.urlLabel": "Broker UI URL",
			"offline.apply": "Apply",
			"offline.invalid": "Not a valid http(s) URL",
			"frame.title": "VBW Visual Browser"
		};
		const ru = {
			"type.label": "VBW Браузер",
			"guide.title": "Открыть VBW",
			"guide.description": "Открыть визуальное рабочее пространство браузера",
			"status.checking": "Проверка брокера…",
			"offline.title": "VBW-брокер не запущен",
			"offline.hint": "Визуальному браузеру нужен локальный VBW-брокер. Запустите его — вкладка подключится сама:",
			"offline.urlLabel": "URL интерфейса брокера",
			"offline.apply": "Применить",
			"offline.invalid": "Это не корректный http(s)-адрес",
			"frame.title": "VBW Визуальный браузер"
		};
		//#endregion
		//#region vbw-client-ui/client/store
		/**
		 * Persisted store holding the broker UI URL (default http://127.0.0.1:8931/ui),
		 * mirroring the shipped createBrowserStore() shape (defineStore + persist key).
		 */
		function createClientStore() {
			return (0, _deepseek_ai_dsh_client_store.defineStore)({
				init: () => ({ uiUrl: DEFAULT_UI_URL }),
				persist: STORE_KEY,
				actions: {
					setUrl: (draft, url) => {
						draft.uiUrl = url;
					}
				}
			});
		}
		//#endregion
		//#region vbw-client-ui/client/styles
		const e = react.createElement;
		const styles = {
			root: { display: "flex", flexDirection: "column", width: "100%", height: "100%", minHeight: 0, overflow: "hidden" },
			frame: { flex: "1 1 auto", width: "100%", height: "100%", border: "0", display: "block", backgroundColor: "#ffffff" },
			offline: { display: "flex", flexDirection: "column", gap: "10px", width: "100%", height: "100%", minHeight: 0, overflow: "auto", padding: "16px", boxSizing: "border-box", color: "var(--dsh-color-text, inherit)", fontSize: "13px", lineHeight: 1.5 },
			offlineTitle: { fontSize: "15px", fontWeight: 600 },
			code: { display: "block", padding: "8px 10px", borderRadius: "8px", background: "rgba(127,127,127,0.12)", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace", fontSize: "12px", whiteSpace: "pre-wrap", wordBreak: "break-all" },
			urlLabel: { marginTop: "8px", opacity: 0.75 },
			urlRow: { display: "flex", gap: "8px" },
			input: { flex: "1 1 auto", minWidth: 0, padding: "6px 8px", borderRadius: "8px", border: "1px solid rgba(127,127,127,0.4)", background: "transparent", color: "inherit", font: "inherit" },
			button: { flex: "0 0 auto", padding: "6px 12px", borderRadius: "8px", border: "1px solid rgba(127,127,127,0.4)", background: "rgba(127,127,127,0.12)", color: "inherit", font: "inherit", cursor: "pointer" },
			error: { color: "#c0392b" }
		};
		//#endregion
		//#region vbw-client-ui/client/OfflinePane
		/** Placeholder shown while the broker is down (must never crash the app). */
		function OfflinePane(props) {
			const { t, uiUrl, checking, onApply } = props;
			const [draft, setDraft] = react.useState(uiUrl);
			const [invalid, setInvalid] = react.useState(false);
			const submit = (event) => {
				event.preventDefault();
				let candidate = draft.trim();
				if (candidate.length === 0) return;
				if (!/^https?:\/\//i.test(candidate)) candidate = "http://" + candidate;
				try {
					const parsed = new URL(candidate);
					setInvalid(false);
					onApply(parsed.origin + "/ui");
				} catch {
					setInvalid(true);
				}
			};
			return e("div", { style: styles.offline },
				e("div", { style: styles.offlineTitle }, checking ? t("status.checking") : t("offline.title")),
				checking ? null : e(react.Fragment, null,
					e("div", null, t("offline.hint")),
					e("code", { style: styles.code }, START_COMMAND),
					e("form", { style: styles.urlRow, onSubmit: submit },
						e("input", {
							style: styles.input,
							value: draft,
							spellCheck: false,
							"aria-label": t("offline.urlLabel"),
							onChange: (event) => setDraft(event.target.value)
						}),
						e("button", { type: "submit", style: styles.button }, t("offline.apply"))
					),
					invalid ? e("div", { style: styles.error }, t("offline.invalid")) : null
				)
			);
		}
		//#endregion
		//#region vbw-client-ui/client/Body
		/**
		 * Tab body: full-size iframe with the broker Visual Browser UI. Polls
		 * GET {origin}/health (unauthenticated per broker-api.md) every 5 s so a
		 * stopped broker renders the start-command placeholder instead of a dead
		 * frame. Framework-injected props: useStore, actions, t.
		 */
		function Body(props) {
			const { useStore, actions, t } = props;
			const uiUrl = useStore((state) => state.uiUrl);
			const [status, setStatus] = react.useState("checking");
			react.useEffect(() => {
				let disposed = false;
				const controller = new AbortController();
				let timer;
				const check = async () => {
					try {
						const healthUrl = new URL("/health", uiUrl);
						const response = await fetch(healthUrl, { signal: controller.signal });
						if (!disposed) setStatus(response.ok ? "up" : "down");
					} catch (error) {
						if (!disposed && controller.signal.aborted !== true) setStatus("down");
					}
				};
				check();
				timer = setInterval(() => {
					if (document.visibilityState === "hidden") return;
					check();
				}, 5000);
				return () => {
					disposed = true;
					clearInterval(timer);
					controller.abort(new DOMException("unmounted", "AbortError"));
				};
			}, [uiUrl]);
			if (status !== "up") {
				return e(OfflinePane, {
					t,
					uiUrl,
					checking: status === "checking",
					onApply: (url) => {
						if (actions?.setUrl !== undefined) actions.setUrl(url);
					}
				});
			}
			return e("div", { style: styles.root },
				e("iframe", {
					src: uiUrl,
					title: t("frame.title"),
					referrerPolicy: "no-referrer",
					style: styles.frame
				})
			);
		}
		//#endregion
		//#region vbw-client-ui/client/definition
		/** Build the tab type with locale-live copy (two-stage registration, stage 1). */
		function tabDefinition(t) {
			return {
				id: TAB_ID,
				kind: "browser",
				priority: "extension",
				title: () => t("type.label"),
				guide: [{
					id: "open",
					order: 30,
					title: () => t("guide.title"),
					description: () => t("guide.description")
				}]
			};
		}
		//#endregion
		//#region vbw-client-ui/client/apply
		/** Required client services. */
		const inject = [
			"slots",
			"locale",
			"sidebarRightTabs"
		];
		/** Register the tab type, its body slot, and the locale copy. */
		function apply(ctx) {
			const t = ctx.locale.bind(NAMESPACE);
			const store = createClientStore();
			ctx.effect(() => ctx.locale.register(NAMESPACE, { en, ru }), "vbw-client-ui: copy");
			ctx.effect(() => ctx.sidebarRightTabs.register({
				...tabDefinition(t),
				keepMounted: true
			}), "vbw-client-ui: type");
			ctx.effect(() => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				locale: NAMESPACE,
				store
			}, Body), "vbw-client-ui: body");
		}
		//#endregion
		exports.PLUGIN_ID = PLUGIN_ID;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
