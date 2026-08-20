// dsh-esxi client-bundle test: loads lib/client.js through a fake browser
// module loader (node:vm), invokes the factory with a real `react`, then
// verifies the direct Settings sidebar section (settings.section) registration and renders the card with
// react-dom/server against a fake settings scope.
// Run: node test/client.mjs
// dsh-esxi 浏览器端测试：通过伪造的浏览器模块加载器（node:vm）加载 lib/client.js，
// 用真实的 `react` 调用 factory，然后校验设置侧边栏分区（settings.section）注册，并用
// react-dom/server 对伪造的 settings scope 渲染卡片。
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";

// Resolve `react` for the Node-side render: prefer a local install inside the
// package, fall back to a dsh profile's node_modules (dev-workspace layout).
function makeRequire() {
	const attempts = [
		new URL("../node_modules/react/package.json", import.meta.url),
		new URL("/home/test/.dsh/profiles/web/node_modules/dsh-esxi/package.json", "file:///")
	];
	for (const anchor of attempts) {
		try {
			const candidate = createRequire(anchor);
			candidate.resolve("react");
			return candidate;
		} catch {
			/* try next anchor */
		}
	}
	throw new Error("cannot resolve react for the client test — install react in the package or run from the dsh-esxi workspace");
}
const require = makeRequire();
const React = require("react");
const { renderToString } = require("react-dom/server");

let passed = 0;
let failed = 0;
function check(label, condition, detail) {
	if (condition) {
		passed += 1;
		console.log(`  ok  ${label}`);
	} else {
		failed += 1;
		console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
	}
}

// ── load the bundle through a fake window ────────────────────────────────────
const code = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let handoff = null;
const window = { __ModuleLoader__: { load: (h) => {
	handoff = h;
} } };
// The bundle references `fetch` (browser global); the vm context must expose
// it, forwarding to the real global so test stubs swap in and out.
vm.runInNewContext(code, { window, fetch: (...args) => globalThis.fetch(...args) });

check("bundle registered a factory", handoff !== null && typeof handoff?.factory === "function");
check("bundle id is the package name", handoff?.id === "dsh-esxi", handoff?.id);

const factoryModule = { exports: {} };
const moduleExports = handoff.factory((name) => {
	if (name === "react") return React;
	throw new Error(`unexpected require("${name}") in client bundle`);
});
check("factory exports apply", typeof moduleExports.apply === "function", typeof moduleExports.apply);
check("factory exports the inject contract (regression: 'cannot get property \"locale\" without inject')", JSON.stringify(moduleExports.inject) === JSON.stringify(["slots", "locale", "settingsScope"]), JSON.stringify(moduleExports.inject));
// Every service the browser apply() touches as a ctx.* property must be
// declared in inject — the loader rejects property access otherwise.
const PROPERTY_SERVICES = ["slots", "locale", "settingsScope"];
check("inject covers every ctx.* service used by apply", PROPERTY_SERVICES.every((name) => moduleExports.inject.includes(name)), JSON.stringify(moduleExports.inject));

// ── fake client ctx (slots / locale / settingsScope) ─────────────────────────
const defaults = {
	govcPath: "govc",
	installDir: "",
	profilesFile: "",
	defaultTimeoutMs: 120000,
	longTimeoutMs: 600000,
	maxOutputBytes: 67108864,
	maxOutputChars: 30000,
	infoCap: 100,
	inventoryMaxItems: 100,
	approveDestructive: true,
	profiles: []
};
function fakeScope(snapshot = {}) {
	let current = {
		status: "ready",
		value: { ...defaults },
		base: { ...defaults },
		user: {},
		revision: 1,
		writable: true,
		mode: "host",
		...snapshot,
		value: { ...defaults, ...(snapshot.value ?? {}) },
		user: snapshot.user ?? {}
	};
	const listeners = new Set();
	return {
		getSnapshot: () => current,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		load: () => {},
		set: async () => {},
		unset: async () => {},
		_publish: (next) => {
			current = next;
			for (const listener of listeners) listener();
		}
	};
}

const registrations = [];
const localeDicts = {};
const ctx = {
	effect(fn) {
		const disposer = fn();
		return typeof disposer === "function" ? disposer : () => {};
	},
	locale: {
		register(ns, lang, dict) {
			localeDicts[lang] = dict;
			return () => {};
		},
		bind(ns) {
			return (key) => localeDicts.en?.[key] ?? key;
		}
	},
	settingsScope: {
		bind(spec) {
			boundSpec = spec;
			return scope;
		}
	},
	slots: {
		inject(name, factory) {
			const registered = factory();
			registrations.push({ slot: name, options: registered.options, component: registered.component });
		},
		register(options, component) {
			return { options, component };
		}
	}
};
let boundSpec = null;
const scope = fakeScope({ value: { govcPath: "/opt/govc", profiles: [{ name: "prod", url: "https://vc1/sdk", username: "admin", password: "pw", insecure: true }] } });
// Faithful cordis loader contract: the loader exposes exactly the services the
// module declares in `inject` (plus lifecycle methods) as ctx properties; any
// other property access throws the same error the real loader raises —
// "cannot get property \"locale\" without inject". This proxy reproduces the
// reported production failure mode.
const ALLOWED_ALWAYS = new Set(["effect", "get", "on", "root", "fiber", "scope", "loader", "logger"]);
const contractedCtx = new Proxy(ctx, {
	get(target, property) {
		if (ALLOWED_ALWAYS.has(property)) return target[property];
		if (typeof property === "string" && moduleExports.inject?.includes(property)) return target[property];
		throw new Error(`cannot get property "${String(property)}" without inject`);
	}
});
moduleExports.apply(contractedCtx);

check("settings.section registered (direct sidebar entry)", registrations.some((r) => r.slot === "settings.section"), JSON.stringify(registrations.map((r) => r.slot)));
const card = registrations.find((r) => r.slot === "settings.section");
check("section id is dsh-esxi", card?.options?.id === "dsh-esxi", card?.options?.id);
check("section has a sidebar label", typeof card?.options?.label === "function", typeof card?.options?.label);
check("settings scope bound to the dsh-esxi namespace", boundSpec?.namespace === "dsh-esxi", JSON.stringify(boundSpec));
check("card component is a function", typeof card?.component === "function");

// ── render the card (react-dom/server, fake scope) ───────────────────────────
const injected = card.options.inject();
const html = renderToString(React.createElement(card.component, { ...injected, t: (key) => localeDicts.en[key] ?? key }));
check("card renders its title", html.includes("ESXi / vCenter"), html.slice(0, 120));
check("card renders plugin fields", html.includes("govc binary") && html.includes("Command timeout (ms)"), html.slice(0, 200));
check("card renders the profiles editor", html.includes("Connection profiles") && html.includes("Add profile"), html.slice(0, 240));
check("card renders a settings-managed profile row", html.includes("https://vc1/sdk"), html.slice(0, 300));
check("card renders save/discard actions", html.includes("Save changes") && html.includes("Discard"), html.slice(0, 200));

// zh locale renders too
const zhHtml = renderToString(React.createElement(card.component, { ...injected, t: (key) => localeDictesZh(key) }));
function localeDictesZh(key) {
	return { title: "ESXi / vCenter（vSphere）", intro: "配置 govc 二进制…", profilesTitle: "连接配置（ESXi 主机信息）", addProfile: "添加配置", save: "保存更改", discard: "放弃", loading: "正在加载设置…", unavailable: "当前部署不提供设置面板。", overridden: "已覆盖", reset: "重置", invalidNumber: "请输入有效数字", saving: "保存中…", saveFailed: "保存失败" }[key] ?? key;
}
check("zh locale renders the title", zhHtml.includes("ESXi / vCenter（vSphere）"), zhHtml.slice(0, 120));

// ── render-state coverage ────────────────────────────────────────────────────
const renderWith = (scopeSnapshot) => renderToString(React.createElement(card.component, {
	scope: fakeScope(scopeSnapshot),
	t: (key) => localeDicts.en[key] ?? key
}));
const loadingHtml = renderWith({ status: "loading" });
check("loading state renders", loadingHtml.includes("Loading settings…"), loadingHtml.slice(0, 120));
const unavailableHtml = renderWith({ status: "unavailable" });
check("unavailable state renders", unavailableHtml.includes("Settings unavailable on this deployment."), unavailableHtml.slice(0, 160));
const readonlyHtml = renderWith({ writable: false, user: {} });
check("read-only disables save", /<button[^>]*disabled=""[^>]*>Save changes<\/button>/.test(readonlyHtml), readonlyHtml.slice(readonlyHtml.indexOf("Save changes") - 120, readonlyHtml.indexOf("Save changes") + 40));
const overriddenHtml = renderWith({ user: { govcPath: "/opt/govc" } });
check("user override shows the overridden badge", overriddenHtml.includes("overridden") && overriddenHtml.includes("Reset"), overriddenHtml.slice(0, 200));

// ── remote-browser bridge (loopback-only settings RPC fallback) ──────────────
const originalFetch = globalThis.fetch;
try {
	// Stub fetch: serve the bridge routes with a descriptor.
	let savePayloads = [];
	globalThis.fetch = async (url, init) => {
		const body = init?.body === undefined ? {} : JSON.parse(init.body);
		if (String(url) === "/esxi/settings.get") {
			return { ok: true, status: 200, json: async () => ({ value: { ...defaults, govcPath: "/remote/govc" }, user: { govcPath: "/remote/govc" }, revision: 7, writable: true }) };
		}
		if (String(url) === "/esxi/settings.save") {
			savePayloads.push(body);
			return { ok: true, status: 200, json: async () => ({ value: { ...defaults }, user: {}, revision: 8, writable: true }) };
		}
		throw new Error(`unexpected fetch ${String(url)}`);
	};

	const { createBridgeScope, createHybridScope } = moduleExports;
	check("bridge exported for tests", typeof createBridgeScope === "function" && typeof createHybridScope === "function");

	const bridge = createBridgeScope();
	check("bridge starts loading", bridge.getSnapshot().status === "loading");
	await bridge.load();
	const ready = bridge.getSnapshot();
	check("bridge loads the descriptor", ready.status === "ready" && ready.value.govcPath === "/remote/govc" && ready.revision === 7 && ready.writable === true, JSON.stringify(ready));
	await bridge.set("defaultTimeoutMs", 4000);
	check("bridge set posts a set op with the revision", savePayloads[0]?.ops?.[0]?.op === "set" && savePayloads[0].ops[0].path[0] === "defaultTimeoutMs" && savePayloads[0].ops[0].value === 4000 && savePayloads[0].expectedRevision === 7, JSON.stringify(savePayloads[0]));
	await bridge.unset("govcPath");
	check("bridge unset posts an unset op", savePayloads[1]?.ops?.[0]?.op === "unset" && savePayloads[1].ops[0].path[0] === "govcPath", JSON.stringify(savePayloads[1]));

	const unavailableNative = fakeScope({ status: "unavailable" });
	const hybrid = createHybridScope(unavailableNative, bridge);
	check("hybrid activates the bridge when the native scope is unavailable", hybrid.getSnapshot().status === "ready", JSON.stringify(hybrid.getSnapshot()));
	check("hybrid still exposes save/unset through the bridge", typeof hybrid.set === "function" && typeof hybrid.unset === "function");

	// End-to-end: apply() with an unavailable native scope → the injected
	// section scope is the hybrid → the card renders the full form after load.
	const remoteRegistrations = [];
	const remoteCtx = {
		effect(fn) {
			const disposer = fn();
			return typeof disposer === "function" ? disposer : () => {};
		},
		locale: ctx.locale,
		settingsScope: { bind: () => unavailableNative },
		slots: {
			inject(name, factory) {
				const registered = factory();
				remoteRegistrations.push({ slot: name, options: registered.options, component: registered.component });
			},
			register: (options, component) => ({ options, component })
		}
	};
	moduleExports.apply(remoteCtx);
	const remoteSection = remoteRegistrations.find((r) => r.slot === "settings.section");
	const remoteScope = remoteSection.options.inject().scope;
	await remoteScope.load();
	const remoteHtml = renderToString(React.createElement(remoteSection.component, { ...remoteSection.options.inject(), t: (key) => localeDicts.en[key] ?? key }));
	check("remote browser renders the full settings form via the bridge", remoteScope.getSnapshot().status === "ready" && remoteHtml.includes("govc binary") && !remoteHtml.includes("Settings unavailable"), remoteHtml.slice(0, 160));
} finally {
	globalThis.fetch = originalFetch;
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
