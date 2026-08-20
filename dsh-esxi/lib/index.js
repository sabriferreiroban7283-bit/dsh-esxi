// dsh-esxi — DSH plugin for ESXi / vCenter (vSphere) operations.
// dsh-esxi —— 面向 ESXi / vCenter（vSphere）运维的 DSH 插件。
//
// Cordis plugin entry: registers the esxi_* tool family against the harness
// tool registry, a destructive-operation approval gate, and a system-prompt
// section. Dependency-free at import time (Node builtins only), so the
// package loads from any install location.
// Cordis 插件入口：向 harness 工具注册表注册 esxi_* 工具族、破坏性操作审批门
// 与系统提示段落。导入期零依赖（仅 Node 内置模块），可从任意安装位置加载。
import { ProfileStore, dshHomePath, profileLabel, resolveProfileForCall } from "./core.js";
import { TOOLS, runTool } from "./catalog.js";
import { applySettingsSurface } from "./settings-host.js";
import { registerSettingsRoutes } from "./settings-routes.js";

const name = "esxi";
const inject = ["tools", "systemPrompt"];

const DEFAULT_CONFIG = {
	govcPath: "govc",
	installDir: undefined,
	profilesFile: undefined,
	defaultTimeoutMs: 120000,
	longTimeoutMs: 600000,
	maxOutputBytes: 64 * 1024 * 1024,
	maxOutputChars: 30000,
	infoCap: 100,
	inventoryMaxItems: 100,
	approveDestructive: true
};

const OUTPUT_SCHEMA = {
	type: "object",
	properties: {
		kind: { type: "string" },
		text: { type: "string" }
	},
	required: ["kind", "text"],
	additionalProperties: false
};

const TOOLS_BY_NAME = Object.fromEntries(TOOLS.map((def) => [def.name, def]));

/** Coerce + validate the loader-provided plugin config against defaults. */
function resolveConfig(raw) {
	const config = { ...DEFAULT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) };
	for (const key of ["defaultTimeoutMs", "longTimeoutMs", "maxOutputBytes", "maxOutputChars", "infoCap", "inventoryMaxItems"]) {
		if (typeof config[key] !== "number" || !Number.isFinite(config[key]) || config[key] <= 0) {
			throw new Error(`dsh-esxi: config "${key}" must be a positive number`);
		}
	}
	if (typeof config.govcPath !== "string" || config.govcPath.length === 0) {
		throw new Error('dsh-esxi: config "govcPath" must be a non-empty string (binary name or absolute path)');
	}
	// A "long operation" timeout below the ordinary one makes no sense; raise it.
	if (config.longTimeoutMs < config.defaultTimeoutMs) config.longTimeoutMs = config.defaultTimeoutMs;
	config.installDir ??= dshHomePath("esxi", "bin");
	config.profilesFile ??= dshHomePath("esxi", "profiles.json");
	return config;
}

/** Emit the harness JSON-schema parameters object for a catalog param table. */
function parametersSchema(params) {
	const properties = {};
	const required = [];
	for (const [key, spec] of Object.entries(params)) {
		properties[key] = {
			type: spec.type,
			description: spec.description,
			...(spec.enum ? { enum: spec.enum } : {}),
			...(spec.items ? { items: { type: spec.items } } : {})
		};
		if (spec.required) required.push(key);
	}
	return { type: "object", properties, ...(required.length > 0 ? { required } : {}) };
}

/** One-line summary of the args for the call card. */
function callSummary(def, args) {
	try {
		const keys = Object.keys(def.params).filter((key) => args?.[key] !== undefined && typeof args[key] !== "object");
		const parts = keys.slice(0, 4).map((key) => `${key}=${JSON.stringify(args[key])}`);
		return parts.length > 0 ? `${def.name} ${parts.join(" ")}` : def.name;
	} catch {
		return def.name;
	}
}

async function apply(ctx, rawConfig) {
	const config = resolveConfig(rawConfig);
	const store = new ProfileStore(config.profilesFile);
	try {
		await store.load();
		ctx.logger?.info(`dsh-esxi: ${store.names().length} connection profile(s) loaded from ${store.file}`);
	} catch (error) {
		ctx.logger?.warn(`dsh-esxi: ${error.message}`);
	}

	// Approval gate: destructive esxi_* calls ask through the harness approval
	// seam (tools/pre-execute → serviceAsk). Fails closed when no channel exists.
	// The gate reads `config.approveDestructive` at call time, so a settings
	// change (Settings → Plugins → Configurable) takes effect without a restart.
	ctx.on("tools/pre-execute", (exec, next) => {
		if (!config.approveDestructive) return next();
		const def = TOOLS_BY_NAME[exec.name];
		if (!def?.gate) return next();
		let reason;
		try {
			reason = def.gate(exec.arguments);
		} catch {
			return next();
		}
		if (!reason) return next();
		let target = "no connection";
		try {
			target = profileLabel(resolveProfileForCall(store, exec.arguments));
		} catch {
			/* no profile configured — the execution will fail with a clear message */
		}
		return { kind: "ask", reason: `[esxi] ${reason} — target: ${target}` };
	});

	for (const def of TOOLS) {
		ctx.tools.register({
			name: def.name,
			description: def.description,
			parameters: parametersSchema(def.params),
			output: {
				schema: OUTPUT_SCHEMA,
				render: (_args, value) => [{ type: "text", text: value && typeof value === "object" && "text" in value ? value.text : String(value) }]
			},
			execute: async (args) => {
				if (def.custom) return await def.custom.call(def, ctx, config, store, args);
				return await runTool(ctx, config, store, def, args);
			},
			presentCall: (args) => {
				try {
					return { card: "generic", title: callSummary(def, args), kind: "execute", rawInput: JSON.stringify(args) };
				} catch {
					return undefined;
				}
			},
			presentResult: (_args, value) => {
				try {
					const text = value && typeof value === "object" && "text" in value ? value.text : String(value);
					return { card: "generic", content: [{ type: "text", text }] };
				} catch {
					return undefined;
				}
			}
		});
	}

	ctx.systemPrompt.section({
		name: "tool:esxi",
		order: 108,
		text: "The esxi_* tools manage ESXi hosts, vCenter Server, and the vSphere ecosystem through the official govc CLI. Start with esxi_doctor (verify the govc binary; install: true downloads it), esxi_connect (add a connection profile), esxi_about (confirm connectivity), then esxi_inventory (map the environment). Destructive operations ask for approval through the session."
	});

	// Settings surface (Settings → "ESXi / vCenter"): registers the `dsh-esxi`
	// settings namespace and re-applies the user's settings layer onto this
	// plugin's config and connection profiles, then — when a webserver exists —
	// bridges the card through /esxi/settings.* HTTP routes so remote
	// (trusted-host) browsers work (the native settings RPC is loopback-only).
	// Services are resolved through `ctx.inject`, which waits for availability
	// regardless of activation order; contexts without `inject` (tests,
	// non-cordis harnesses) take the immediate path.
	// 设置界面（设置 → "ESXi / vCenter"）：注册 `dsh-esxi` 设置命名空间并把用户
	// 设置层实时应用到插件配置与连接 profile；存在 web 服务器时，再通过
	// /esxi/settings.* HTTP 路由桥接卡片，使远程（trusted-host）浏览器可用
	// （原生设置 RPC 仅限环回）。服务通过 `ctx.inject` 解析（等待可用，与激活
	// 顺序无关）；没有 `inject` 的上下文（测试/非 cordis 环境）走立即路径。
	const activateSurface = async (scopeCtx) => {
		const settings = scopeCtx?.get?.("settings");
		if (!settings) return;
		let surface;
		try {
			surface = await applySettingsSurface(ctx, config, store, settings);
		} catch (error) {
			ctx.logger?.warn(`dsh-esxi: settings surface failed to activate: ${error.message}`);
			return;
		}
		if (!surface.enabled) {
			ctx.logger?.info(`dsh-esxi: settings surface disabled — ${surface.reason ?? "unknown"}`);
			return;
		}
		const registerRoutes = (webCtx) => {
			const webServer = webCtx?.get?.("webServer");
			if (!webServer) return;
			try {
				if (registerSettingsRoutes(ctx, settings, webServer)) {
					ctx.logger?.info("dsh-esxi: /esxi/settings.* bridge routes registered");
				}
			} catch (error) {
				ctx.logger?.warn(`dsh-esxi: settings bridge routes failed: ${error.message}`);
			}
		};
		if (typeof ctx.inject === "function") ctx.inject(["webServer"], registerRoutes);
		else registerRoutes(ctx);
	};
	if (typeof ctx.inject === "function") ctx.inject(["settings"], (scopeCtx) => {
		void activateSurface(scopeCtx);
	});
	else void activateSurface(ctx);
}

export { apply, inject, name };
