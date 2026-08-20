// dsh-esxi browser half: the dedicated configuration card in
// Settings → Plugins → Configurable, registered against the `dsh-esxi`
// settings namespace served by the host plugin.
// dsh-esxi 浏览器端：设置 → 插件 → 可配置 下的专用配置卡片，挂在主机插件托管的
// `dsh-esxi` 设置命名空间上。
//
// Bundle contract: `window.__ModuleLoader__.load({id, factory})` with a
// factory(require) returning module.exports; the only external dependency is
// `react` (provided by the client module table). All cross-plugin
// collaboration goes through injected client services (slots, locale,
// settingsScope) — no @deepseek-ai client imports, per the bundle purity gate.
// 包契约：`window.__ModuleLoader__.load({id, factory})`，factory(require) 返回
// module.exports；唯一外部依赖是 `react`（由客户端模块表提供）。所有跨插件协作
// 均通过注入的客户端服务（slots、locale、settingsScope）完成——不导入任何
// @deepseek-ai 客户端包（符合 bundle 纯净门禁）。
window.__ModuleLoader__.load({
	id: "dsh-esxi",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const NS = "dsh-esxi";

		const en = {
			nav: "ESXi / vCenter",
			title: "ESXi / vCenter (vSphere)",
			intro: "Configure the govc binary, timeouts, and ESXi / vCenter connection profiles. Saved values land in settings.yaml and take effect immediately; destructive operations still require in-session approval.",
			loading: "Loading settings…",
			unavailable: "Settings unavailable on this deployment.",
			overridden: "overridden",
			reset: "Reset",
			invalidNumber: "Enter a valid number",
			save: "Save changes",
			discard: "Discard",
			saving: "Saving…",
			saveFailed: "Save failed — the settings document may have changed; review and retry.",
			fGovcPath: "govc binary",
			hGovcPath: "Binary name or absolute path of the govc CLI (default \"govc\").",
			fInstallDir: "govc install dir",
			hInstallDir: "Where esxi_doctor installs govc when missing (default <dsh home>/esxi/bin).",
			fProfilesFile: "Profiles file",
			hProfilesFile: "Connection-profile document (default <dsh home>/esxi/profiles.json).",
			fDefaultTimeoutMs: "Command timeout (ms)",
			hDefaultTimeoutMs: "Ordinary command timeout (default 120000).",
			fLongTimeoutMs: "Long-operation timeout (ms)",
			hLongTimeoutMs: "Export/upload/clone/migrate timeout (default 600000).",
			fMaxOutputBytes: "Max output buffer (bytes)",
			hMaxOutputBytes: "govc output capture limit (default 67108864).",
			fMaxOutputChars: "Max output shown to the model",
			hMaxOutputChars: "Model-visible output cap in characters (default 30000).",
			fInfoCap: "Info enrichment cap",
			hInfoCap: "Max VMs/hosts enriched with details in list tools (default 100).",
			fInventoryMaxItems: "Inventory names per type",
			hInventoryMaxItems: "Names shown per object type in esxi_inventory (default 100).",
			fApproveDestructive: "Ask approval for destructive operations",
			hApproveDestructive: "Gate VM deletes, host maintenance, datastore deletes, esxcli, and similar behind the in-session approval prompt (default on).",
			profilesTitle: "Connection profiles (ESXi host details)",
			profilesHint: "vCenter Server or standalone ESXi hosts. Passwords are stored in settings.yaml (mode 0600) and are never shown after saving. Profiles configured here override same-named profiles from esxi_connect.",
			addProfile: "Add profile",
			removeProfile: "Remove",
			pName: "Name",
			pUrl: "URL / host",
			pUsername: "Username",
			pPassword: "Password",
			pInsecure: "Skip TLS verification",
			pDatacenter: "Datacenter",
			pFolder: "Folder",
			pTlsCaCerts: "CA bundle path",
			placeholderUrl: "vc01.example.com or https://vc01.example.com/sdk",
			placeholderUser: "administrator@vsphere.local or root"
		};
		const zh = {
			nav: "ESXi / vCenter",
			title: "ESXi / vCenter（vSphere）",
			intro: "配置 govc 二进制、超时参数与 ESXi / vCenter 连接配置。保存后的值写入 settings.yaml 并立即生效；破坏性操作仍需在会话内批准。",
			loading: "正在加载设置…",
			unavailable: "当前部署不提供设置面板。",
			overridden: "已覆盖",
			reset: "重置",
			invalidNumber: "请输入有效数字",
			save: "保存更改",
			discard: "放弃",
			saving: "保存中…",
			saveFailed: "保存失败——设置文档可能已被修改，请检查后重试。",
			fGovcPath: "govc 二进制",
			hGovcPath: "govc CLI 的二进制名或绝对路径（默认 \"govc\"）。",
			fInstallDir: "govc 安装目录",
			hInstallDir: "esxi_doctor 在缺少 govc 时安装到的目录（默认 <dsh home>/esxi/bin）。",
			fProfilesFile: "连接配置文档",
			hProfilesFile: "连接配置（profile）文档路径（默认 <dsh home>/esxi/profiles.json）。",
			fDefaultTimeoutMs: "命令超时（毫秒）",
			hDefaultTimeoutMs: "普通命令超时（默认 120000）。",
			fLongTimeoutMs: "长任务超时（毫秒）",
			hLongTimeoutMs: "导出/上传/克隆/迁移超时（默认 600000）。",
			fMaxOutputBytes: "最大输出缓冲（字节）",
			hMaxOutputBytes: "govc 输出捕获上限（默认 67108864）。",
			fMaxOutputChars: "模型可见输出上限",
			hMaxOutputChars: "模型可见输出字符数上限（默认 30000）。",
			fInfoCap: "信息补全上限",
			hInfoCap: "列表工具中补全详情的最大 VM/主机数（默认 100）。",
			fInventoryMaxItems: "清单中每类名称数",
			hInventoryMaxItems: "esxi_inventory 中每类对象展示的名称数（默认 100）。",
			fApproveDestructive: "破坏性操作需批准",
			hApproveDestructive: "将 VM 删除、主机维护、数据存储删除、esxcli 等操作置于会话内审批提示之后（默认开启）。",
			profilesTitle: "连接配置（ESXi 主机信息）",
			profilesHint: "vCenter Server 或独立 ESXi 主机。密码保存在 settings.yaml（权限 0600），保存后不再显示。此处配置的 profile 会覆盖 esxi_connect 中同名配置。",
			addProfile: "添加配置",
			removeProfile: "删除",
			pName: "名称",
			pUrl: "URL / 主机",
			pUsername: "用户名",
			pPassword: "密码",
			pInsecure: "跳过 TLS 校验",
			pDatacenter: "数据中心",
			pFolder: "文件夹",
			pTlsCaCerts: "CA 证书路径",
			placeholderUrl: "vc01.example.com 或 https://vc01.example.com/sdk",
			placeholderUser: "administrator@vsphere.local 或 root"
		};

		// DSH design tokens — same vocabulary the native plugin cards use.
		const css = {
			card: { maxWidth: 760, display: "flex", flexDirection: "column", gap: 10, padding: "14px 16px", border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: 12 },
			heading: { margin: 0, fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary)", lineHeight: 1.4 },
			intro: { margin: 0, fontSize: 13, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 },
			sectionTitle: { margin: "10px 0 0", fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			field: { display: "flex", flexDirection: "column", gap: 4, padding: "10px 0", borderTop: "1px solid var(--dsw-alias-border-l1)" },
			fieldHead: { display: "flex", alignItems: "center", gap: 8 },
			label: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: "var(--dsw-alias-label-primary)", lineHeight: 1.5 },
			hint: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-tertiary)", lineHeight: 1.5 },
			badge: { flex: "none", whiteSpace: "nowrap", fontSize: 11, fontWeight: 500, color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-bg-module-platform)", borderRadius: 999, padding: "1px 8px" },
			reset: { flex: "none", font: "inherit", fontSize: 12, color: "var(--dsw-alias-label-secondary)", cursor: "pointer", background: "none", border: "none", padding: 0 },
			input: { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", height: 32, font: "inherit", color: "var(--dsw-alias-label-primary)", borderRadius: 8, padding: "0 10px", fontSize: 13, lineHeight: 1.5, boxSizing: "border-box" },
			inputInvalid: { borderColor: "var(--dsw-alias-label-error)" },
			checkboxRow: { display: "flex", alignItems: "center", gap: 8 },
			profileBox: { display: "flex", flexDirection: "column", gap: 8, padding: 10, border: "1px solid var(--dsw-alias-border-l1)", borderRadius: 10, background: "var(--dsw-alias-bg-layer-2)" },
			profileHead: { display: "flex", alignItems: "center", gap: 8 },
			profileTitle: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: "var(--dsw-alias-label-primary)" },
			remove: { flex: "none", font: "inherit", fontSize: 12, color: "var(--dsw-alias-state-error-primary)", cursor: "pointer", background: "none", border: "none", padding: 0 },
			grid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8 },
			gridField: { display: "flex", flexDirection: "column", gap: 4 },
			gridLabel: { fontSize: 12, color: "var(--dsw-alias-label-secondary)" },
			error: { margin: 0, fontSize: 12, color: "var(--dsw-alias-label-error)" },
			footer: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 8, padding: "10px 0 2px", borderTop: "1px solid var(--dsw-alias-border-l1)" },
			primary: { background: "var(--dsw-alias-label-primary)", color: "var(--dsw-alias-bg-layer-3)", font: "inherit", fontSize: 13, cursor: "pointer", border: "1px solid transparent", borderRadius: 8, padding: "5px 14px", lineHeight: 1.5 },
			ghost: { background: "none", color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: 13, cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "5px 14px", lineHeight: 1.5 },
			disabled: { opacity: 0.45, cursor: "default" },
			add: { alignSelf: "flex-start", background: "none", color: "var(--dsw-alias-brand-primary)", font: "inherit", fontSize: 13, cursor: "pointer", border: "1px solid var(--dsw-alias-border-l2)", borderRadius: 8, padding: "5px 14px", lineHeight: 1.5 }
		};

		const FIELD_SPECS = [
			{ key: "govcPath", type: "text" },
			{ key: "installDir", type: "text" },
			{ key: "profilesFile", type: "text" },
			{ key: "defaultTimeoutMs", type: "number" },
			{ key: "longTimeoutMs", type: "number" },
			{ key: "maxOutputBytes", type: "number" },
			{ key: "maxOutputChars", type: "number" },
			{ key: "infoCap", type: "number" },
			{ key: "inventoryMaxItems", type: "number" },
			{ key: "approveDestructive", type: "bool" }
		];
		const PROFILE_FIELDS = [
			{ key: "name", labelKey: "pName" },
			{ key: "url", labelKey: "pUrl" },
			{ key: "username", labelKey: "pUsername" },
			{ key: "password", labelKey: "pPassword", secret: true },
			{ key: "datacenter", labelKey: "pDatacenter" },
			{ key: "folder", labelKey: "pFolder" },
			{ key: "tlsCaCerts", labelKey: "pTlsCaCerts" }
		];

		const emptyProfile = () => ({ name: "", url: "", username: "", password: "", insecure: true, datacenter: "", folder: "", tlsCaCerts: "" });
		const cloneProfiles = (list) => (list ?? []).map((p) => ({ ...emptyProfile(), ...p }));
		const sameArray = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

		/** The dedicated configuration card. */
		function EsxiSettingsCard(props) {
			const scope = props.scope;
			const t = props.t ?? ((key) => en[key] ?? key);
			const [snapshot, setSnapshot] = React.useState(() => scope.getSnapshot());
			const [drafts, setDrafts] = React.useState({});
			const [profilesDraft, setProfilesDraft] = React.useState(null);
			const [saving, setSaving] = React.useState(false);
			const [error, setError] = React.useState(null);
			React.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope]);
			React.useEffect(() => {
				// The legacy settings scope needed an explicit load(); current
				// cores derive the snapshot from a shared mirror automatically
				// and expose no load method, so only call it when present.
				if (typeof scope.load === "function") scope.load();
			}, [scope]);

			if (snapshot.status !== "ready") {
				return React.createElement("div", { style: css.card },
					React.createElement("h3", { style: css.heading }, t("title")),
					React.createElement("p", { style: css.intro }, snapshot.status === "loading" ? t("loading") : t("unavailable")));
			}
			const value = snapshot.value ?? {};
			const user = snapshot.user ?? {};
			const writable = snapshot.writable === true;
			const profiles = profilesDraft !== null ? profilesDraft : value.profiles ?? [];
			const dirty = Object.keys(drafts).length > 0 || profilesDraft !== null;

			const editField = (key, text) => {
				setError(null);
				setDrafts((prev) => ({ ...prev, [key]: { text } }));
			};
			const toggleField = (key, next) => {
				setError(null);
				setDrafts((prev) => ({ ...prev, [key]: { bool: next } }));
			};
			const resetField = (key) => {
				setError(null);
				setDrafts((prev) => {
					const next = { ...prev };
					delete next[key];
					return next;
				});
				scope.unset(key);
			};
			const editProfile = (index, key, next) => {
				setError(null);
				setProfilesDraft((prev) => {
					const list = cloneProfiles(prev !== null ? prev : value.profiles ?? []);
					list[index] = { ...list[index], [key]: next };
					return list;
				});
			};
			const addProfile = () => {
				setError(null);
				setProfilesDraft((prev) => [...cloneProfiles(prev !== null ? prev : value.profiles ?? []), emptyProfile()]);
			};
			const removeProfile = (index) => {
				setError(null);
				setProfilesDraft((prev) => cloneProfiles(prev !== null ? prev : value.profiles ?? []).filter((_, i) => i !== index));
			};
			const discard = () => {
				setDrafts({});
				setProfilesDraft(null);
				setError(null);
			};
			const save = async () => {
				const parsed = {};
				for (const spec of FIELD_SPECS) {
					const draft = drafts[spec.key];
					if (!draft) continue;
					const labelKey = `f${spec.key[0].toUpperCase()}${spec.key.slice(1)}`;
					if (spec.type === "number") {
						const number = Number(draft.text);
						if (!Number.isFinite(number)) {
							setError(`${t(labelKey)}: ${t("invalidNumber")}`);
							return;
						}
						parsed[spec.key] = number;
					} else if (spec.type === "bool") {
						parsed[spec.key] = draft.bool;
					} else {
						parsed[spec.key] = draft.text;
					}
				}
				setSaving(true);
				setError(null);
				let ok = true;
				for (const [key, raw] of Object.entries(parsed)) {
					if (typeof raw === "string" && raw.trim() === "") {
						await scope.unset(key).then(() => true, () => false) ? null : (ok = false);
					} else {
						await scope.set(key, raw).then(() => true, () => false) ? null : (ok = false);
					}
				}
				if (profilesDraft !== null) {
					await scope.set("profiles", profilesDraft).then(() => true, () => false) ? null : (ok = false);
				}
				setSaving(false);
				if (ok) {
					setDrafts({});
					setProfilesDraft(null);
				} else {
					setError(t("saveFailed"));
				}
			};

			const fields = FIELD_SPECS.map((spec) => {
				const label = t(`f${spec.key[0].toUpperCase()}${spec.key.slice(1)}`);
				const hint = t(`h${spec.key[0].toUpperCase()}${spec.key.slice(1)}`);
				const draft = drafts[spec.key];
				if (spec.type === "bool") {
					const checked = draft ? draft.bool : value[spec.key] === true;
					const overridden = !draft && user[spec.key] !== undefined;
					return React.createElement("div", { style: css.field, key: spec.key },
						React.createElement("div", { style: css.checkboxRow },
							React.createElement("input", { type: "checkbox", checked, disabled: !writable || saving, onChange: (event) => toggleField(spec.key, event.target.checked), style: { accentColor: "var(--dsw-alias-brand-primary)" } }),
							React.createElement("span", { style: css.label }, label),
							overridden ? React.createElement("span", { style: css.badge }, t("overridden")) : null,
							!draft && overridden ? React.createElement("button", { style: css.reset, onClick: () => resetField(spec.key), disabled: saving }, t("reset")) : null),
						React.createElement("p", { style: css.hint }, hint));
				}
				const text = draft ? draft.text : String(value[spec.key] ?? "");
				const invalid = spec.type === "number" && draft && !Number.isFinite(Number(draft.text));
				const overridden = !draft && user[spec.key] !== undefined;
				return React.createElement("div", { style: css.field, key: spec.key },
					React.createElement("div", { style: css.fieldHead },
						React.createElement("span", { style: css.label }, label),
						overridden ? React.createElement("span", { style: css.badge }, t("overridden")) : null,
						!draft && overridden ? React.createElement("button", { style: css.reset, onClick: () => resetField(spec.key), disabled: saving }, t("reset")) : null),
					React.createElement("input", {
						type: "text",
						style: { ...css.input, ...(invalid ? css.inputInvalid : {}) },
						value: text,
						disabled: !writable || saving,
						onChange: (event) => editField(spec.key, event.target.value),
						spellCheck: false
					}),
					React.createElement("p", { style: { ...css.hint, ...(invalid ? css.error : {}) } }, invalid ? t("invalidNumber") : hint));
			});

			const profileRows = profiles.map((profile, index) => {
				const inputs = PROFILE_FIELDS.map((field) => {
					const label = t(field.labelKey);
					const current = profile[field.key] ?? "";
					const isBool = field.key === "insecure";
					if (isBool) {
						return React.createElement("label", { style: { ...css.gridField, flexDirection: "row", alignItems: "center", gap: 6 }, key: field.key },
							React.createElement("input", { type: "checkbox", checked: profile.insecure === true, onChange: (event) => editProfile(index, "insecure", event.target.checked) }),
							React.createElement("span", { style: css.gridLabel }, t("pInsecure")));
					}
					return React.createElement("label", { style: css.gridField, key: field.key },
						React.createElement("span", { style: css.gridLabel }, label),
						React.createElement("input", {
							type: field.secret ? "password" : "text",
							style: css.input,
							value: current,
							placeholder: field.key === "url" ? t("placeholderUrl") : field.key === "username" ? t("placeholderUser") : "",
							onChange: (event) => editProfile(index, field.key, event.target.value),
							spellCheck: false
						}));
				});
				return React.createElement("div", { style: css.profileBox, key: index },
					React.createElement("div", { style: css.profileHead },
						React.createElement("span", { style: css.profileTitle }, `${t("pName")} ${index + 1}${profile.name ? ` — ${profile.name}` : ""}`),
						React.createElement("button", { style: css.remove, onClick: () => removeProfile(index), disabled: saving }, t("removeProfile"))),
					React.createElement("div", { style: css.grid }, ...inputs));
			});

			return React.createElement("div", { style: css.card },
				React.createElement("h3", { style: css.heading }, t("title")),
				React.createElement("p", { style: css.intro }, t("intro")),
				...fields,
				React.createElement("h4", { style: css.sectionTitle }, t("profilesTitle")),
				React.createElement("p", { style: css.intro }, t("profilesHint")),
				...profileRows,
				React.createElement("button", { style: css.add, onClick: addProfile, disabled: saving }, t("addProfile")),
				error ? React.createElement("p", { style: { ...css.error, paddingTop: 6 } }, error) : null,
				React.createElement("div", { style: css.footer },
					React.createElement("button", { style: { ...css.primary, ...((!dirty || saving || !writable) ? css.disabled : {}) }, disabled: !dirty || saving || !writable, onClick: save }, saving ? t("saving") : t("save")),
					React.createElement("button", { style: { ...css.ghost, ...((!dirty || saving) ? css.disabled : {}) }, disabled: !dirty || saving, onClick: discard }, t("discard"))));
		}

		/** Browser plugin body: locale dictionary + the direct Settings sidebar section. */
		// Cordis contract: `inject` on the module exports is REQUIRED — it is what
		// lets the client loader expose these services as ctx.* properties; without
		// it, the first `ctx.locale` access fails with
		// "cannot get property \"locale\" without inject".
		// Cordis 契约：模块导出中的 `inject` 是必需的——客户端加载器据此把这些
		// 服务暴露为 ctx.* 属性；缺失时第一次访问 `ctx.locale` 就会报
		// "cannot get property \"locale\" without inject"。
		const inject = ["slots", "locale", "settingsScope"];

		/**
		* HTTP bridge scope: the harness settings RPC is loopback-only, so remote
		* (trusted-host) browsers get an "unavailable" native scope. This scope
		* mirrors the native surface (getSnapshot/subscribe/load/set/unset) over
		* the plugin's own /esxi/settings.* routes, guarded host-side by the same
		* trust fence as the API gateway.
		* HTTP 桥接 scope：harness 的设置 RPC 仅限环回，远程（trusted-host）浏览器
		* 会拿到 "unavailable" 的原生 scope。本 scope 通过插件自身的
		* /esxi/settings.* 路由镜像原生接口（getSnapshot/subscribe/load/set/unset），
		* 主机侧使用与 API 网关相同的信任围栏防护。
		*/
		function createBridgeScope() {
			let snapshot = { status: "loading", value: undefined, base: undefined, user: {}, revision: undefined, writable: false, mode: "remote" };
			const listeners = new Set();
			const publish = () => {
				for (const listener of [...listeners]) listener();
			};
			const request = async (path, payload) => {
				const response = await fetch(path, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(payload ?? {})
				});
				const parsed = await response.json().catch(() => null);
				if (!response.ok || parsed === null) throw new Error(parsed?.error ?? `HTTP ${response.status}`);
				return parsed;
			};
			const accept = (value) => {
				snapshot = { status: "ready", value: value.value, user: value.user ?? {}, revision: value.revision, writable: value.writable === true, mode: "remote" };
				publish();
				return true;
			};
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				async load() {
					try {
						accept(await request("/esxi/settings.get"));
					} catch {
						snapshot = { ...snapshot, status: "unavailable" };
						publish();
					}
				},
				async set(field, value) {
					try {
						return accept(await request("/esxi/settings.save", {
							ops: [{ op: "set", path: [field], value }],
							...(snapshot.revision !== undefined ? { expectedRevision: snapshot.revision } : {})
						}));
					} catch {
						return false;
					}
				},
				async unset(field) {
					try {
						return accept(await request("/esxi/settings.save", {
							ops: [{ op: "unset", path: [field] }],
							...(snapshot.revision !== undefined ? { expectedRevision: snapshot.revision } : {})
						}));
					} catch {
						return false;
					}
				}
			};
		}

		/**
		* Hybrid scope: uses the native settings scope on loopback browsers and
		* transparently falls back to the HTTP bridge when the native snapshot is
		* "unavailable" (remote browsers).
		* 混合 scope：环回浏览器走原生 settings scope；当原生快照为
		* "unavailable"（远程浏览器）时，透明切换到 HTTP 桥接。
		*/
		function createHybridScope(native, bridge) {
			const listeners = new Set();
			let bridgeActive = false;
			const publish = () => {
				for (const listener of [...listeners]) listener();
			};
			const activateBridge = () => {
				if (!bridgeActive) {
					bridgeActive = true;
					bridge.load();
				}
			};
			native.subscribe(() => {
				if (native.getSnapshot().status === "unavailable") activateBridge();
				publish();
			});
			bridge.subscribe(publish);
			if (native.getSnapshot().status === "unavailable") activateBridge();
			return {
				getSnapshot: () => (bridgeActive ? bridge : native).getSnapshot(),
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				load: () => (bridgeActive ? bridge : native).load?.(),
				set: (field, value) => (bridgeActive ? bridge : native).set(field, value),
				unset: (field) => (bridgeActive ? bridge : native).unset(field)
			};
		}

		function apply(ctx) {
			ctx.effect(() => {
				const offZh = ctx.locale.register(NS, "zh", zh);
				const offEn = ctx.locale.register(NS, "en", en);
				return () => {
					offZh();
					offEn();
				};
			}, "dsh-esxi: locale");
			const t = ctx.locale.bind(NS);
			const scope = createHybridScope(ctx.settingsScope.bind({ namespace: NS }), createBridgeScope());
			// Direct Settings sidebar section — the same mechanism better-sidebar
			// uses for its own settings entry, so "ESXi / vCenter" appears in the
			// Settings navigation and opens this card on click.
			// 直接在「设置」侧边栏注册一个分区——与 better-sidebar 自己的设置入口
			// 同机制：侧边栏出现「ESXi / vCenter」，点击即打开本卡片。
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-esxi",
				order: 110,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ scope, t })
			}, EsxiSettingsCard));
		}

		module.exports = { apply, inject, createBridgeScope, createHybridScope };
		return module.exports;
	}
});
