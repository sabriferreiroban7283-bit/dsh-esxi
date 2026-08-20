// Host-side settings surface for dsh-esxi.
// 面向 dsh-esxi 的主机侧设置界面支持。
//
// Registers the `dsh-esxi` settings namespace (schemastery schema) with the
// harness Settings service so the browser settings panel (Settings → Plugins →
// Configurable) can render a dedicated configuration card, and re-applies the
// user's settings layer onto the live plugin config and connection-profile
// store. schemastery is imported lazily with a graceful fallback: the tools
// keep working without the settings surface (e.g. when the package is
// installed somewhere @deepseek-ai/schemastery does not resolve).
// 向 harness 的 Settings 服务注册 `dsh-esxi` 设置命名空间（schemastery
// schema），使浏览器设置面板（设置 → 插件 → 可配置）能渲染专用配置卡片；并把
// 用户设置层实时应用到插件配置与连接配置（profile）存储。schemastery 采用惰性
// 导入并带优雅降级：即使解析不到（例如安装位置无法解析 @deepseek-ai/schemastery），
// 工具仍然照常工作，只是不启用设置界面。

import { normalizeUrl } from "./core.js";

const NAMESPACE = "dsh-esxi";

/** Settings-namespace brand pattern (mirrors `settingsNamespace` in @deepseek-ai/dsh-settings). */
const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Path fields only override the plugin config when non-empty (empty = "use the default"). */
const PATH_FIELDS = ["govcPath", "installDir", "profilesFile"];
/** Scalar fields always override. */
const SCALAR_FIELDS = ["defaultTimeoutMs", "longTimeoutMs", "maxOutputBytes", "maxOutputChars", "infoCap", "inventoryMaxItems", "approveDestructive"];

/** Build the schemastery schema for the `dsh-esxi` namespace. */
function buildSchema(z) {
	const profile = z.object({
		name: z.string().required(),
		url: z.string().required(),
		username: z.string().required(),
		password: z.string().role("secret").default(""),
		insecure: z.boolean().default(true),
		datacenter: z.string().default(""),
		folder: z.string().default(""),
		tlsCaCerts: z.string().default("")
	});
	return z.object({
		govcPath: z.string().default("govc"),
		installDir: z.string().default(""),
		profilesFile: z.string().default(""),
		defaultTimeoutMs: z.number().default(120000),
		longTimeoutMs: z.number().default(600000),
		maxOutputBytes: z.number().default(64 * 1024 * 1024),
		maxOutputChars: z.number().default(30000),
		infoCap: z.number().default(100),
		inventoryMaxItems: z.number().default(100),
		approveDestructive: z.boolean().default(true),
		profiles: z.array(profile).default([])
	});
}

/** Apply one resolved settings value onto the live plugin config. */
function applyConfigLayer(config, value) {
	for (const key of PATH_FIELDS) {
		if (typeof value[key] === "string" && value[key].length > 0) config[key] = value[key];
	}
	for (const key of SCALAR_FIELDS) {
		if (typeof value[key] === "number" || typeof value[key] === "boolean") config[key] = value[key];
	}
}

/** Apply settings-defined connection profiles onto the in-memory profile store (never persisted to profiles.json).
*  The settings list is authoritative: profiles previously marked `settingsManaged` that are no longer listed
*  are dropped, while esxi_connect-created profiles (not settings-managed) are left untouched. URLs are
*  normalized the same way esxi_connect normalizes them. */
function applySettingsProfiles(store, profiles) {
	for (const name of store.names()) {
		if (store.get(name)?.settingsManaged) store.remove(name);
	}
	for (const profile of profiles ?? []) {
		if (!profile || typeof profile.name !== "string" || profile.name.length === 0 || typeof profile.url !== "string") continue;
		let url;
		try {
			url = normalizeUrl(profile.url);
		} catch {
			continue;
		}
		const record = {
			url,
			username: profile.username ?? "",
			insecure: profile.insecure ?? true,
			settingsManaged: true,
			...(profile.password ? { password: profile.password } : {}),
			...(profile.datacenter ? { datacenter: profile.datacenter } : {}),
			...(profile.folder ? { folder: profile.folder } : {}),
			...(profile.tlsCaCerts ? { tlsCaCerts: profile.tlsCaCerts } : {})
		};
		store.upsert(profile.name, record);
	}
	if (profiles?.length > 0 && store.defaultName() === undefined) store.setDefault(profiles[0].name);
}

/**
* Register the settings surface and wire live re-application. The settings
* service is passed in by the caller (resolved through `ctx.inject`, which
* waits for availability) so the surface works regardless of activation order.
* @returns `{ enabled, reason? }` — degraded gracefully when the harness
*   settings service or schemastery is unavailable.
*/
export async function applySettingsSurface(ctx, config, store, settings) {
	if (!settings || typeof settings.register !== "function") {
		return { enabled: false, reason: "settings service unavailable" };
	}
	let z;
	try {
		z = (await import("@deepseek-ai/schemastery")).default;
	} catch (error) {
		return { enabled: false, reason: `schemastery unavailable: ${error.message}` };
	}
	if (!NAMESPACE_PATTERN.test(NAMESPACE)) throw new Error(`settings namespace "${NAMESPACE}" is invalid`);
	const schema = buildSchema(z);
	const scope = settings.register(NAMESPACE, schema);
	const apply = () => {
		const value = scope.get() ?? {};
		applyConfigLayer(config, value);
		applySettingsProfiles(store, value.profiles);
	};
	apply();
	scope.watch(() => apply());
	ctx.logger?.info(`dsh-esxi: settings surface enabled (namespace "${NAMESPACE}")`);
	return { enabled: true, settings, scope, schema, apply };
}

export { NAMESPACE };
