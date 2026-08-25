// Host-side HTTP bridge for the dsh-esxi settings card.
// 面向 dsh-esxi 设置卡片的主机侧 HTTP 桥。
//
// The harness settings RPC is loopback-only: remote browsers (the GUI
// served through --trusted-host authorities) get an "unavailable" settings
// scope. Like dsh-better-sidebar, this module bridges the card through the
// plugin's own JSON routes, guarded by the SAME browser-trust fence the API
// gateway uses: Host-header loopback or the web runtime's `trustedHosts`
// (LAN IP literals sampled at boot plus --trusted-host authorities), plus
// same-origin browser markers.
// harness 的设置 RPC 仅限环回：远程浏览器（通过 --trusted-host 提供的 GUI）会
// 拿到 "unavailable" 的设置 scope。与 dsh-better-sidebar 一样，本模块通过插件
// 自己的 JSON 路由桥接卡片，并使用与 API 网关相同的浏览器信任围栏：Host 头为
// 环回地址或 web 运行时的 `trustedHosts`（启动时采样的局域网 IP 与
// --trusted-host 地址），且浏览器标记同源。
import { NAMESPACE } from "./settings-host.js";

/** Parse a Host header value into a URL (throw-free; undefined when malformed). */
function parseAuthority(host) {
	try {
		return new URL(`http://${host}`);
	} catch {
		return undefined;
	}
}

/** Whether a normalized hostname names the local loopback authority. */
function isLoopbackHostname(hostname) {
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part));
}

/** Whether the request authority matches a trustedHosts entry (exact or port-less). */
function isTrustedAuthority(hostUrl, trustedHosts) {
	return trustedHosts.some((entry) => {
		try {
			const entryUrl = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(entry) ? entry : `http://${entry}`);
			return entryUrl.port === "" ? entryUrl.hostname === hostUrl.hostname : entryUrl.host === hostUrl.host;
		} catch {
			return false;
		}
	});
}

function header(request, name) {
	const value = request?.headers?.[name];
	return Array.isArray(value) ? value[0] : value;
}

/**
* Browser-trust fence mirroring the /api gateway's: the Host must be loopback
* or a trusted authority, and browser markers must be same-origin.
* @returns true when the request may reach plugin routes.
*/
export function isTrustedApiRequest(request, trustedHosts) {
	const host = header(request, "host");
	if (host === undefined) return false;
	const hostUrl = parseAuthority(host);
	if (hostUrl === undefined) return false;
	if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false;
	if (header(request, "sec-fetch-site") === "cross-site") return false;
	const origin = header(request, "origin");
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/**
* Apply top-level field ops onto the namespace's user layer, then commit via
* `settings.replace` (revision-fenced). All card fields are top-level, so a
* path depth of exactly one is required.
*/
export async function applySettingsOps(settings, ns, ops, expectedRevision) {
	const descriptor = (settings.describe({ redactSecrets: true }) ?? []).find((candidate) => candidate.ns === ns);
	const next = { ...(descriptor?.user ?? {}) };
	for (const op of ops) {
		if (!op || typeof op !== "object" || typeof op.op !== "string" || !Array.isArray(op.path) || op.path.length !== 1 || typeof op.path[0] !== "string") {
			throw new Error(`invalid settings op: ${JSON.stringify(op)}`);
		}
		if (op.op === "set") next[op.path[0]] = op.value;
		else if (op.op === "unset") delete next[op.path[0]];
		else throw new Error(`unknown settings op "${op.op}"`);
	}
	return settings.replace(ns, next, expectedRevision);
}

/** Read the card-facing descriptor for the namespace (redacted, writable). */
function redactDescriptorLayer(layer) {
	if (layer === undefined || layer === null || typeof layer !== "object") return layer;
	const copy = JSON.parse(JSON.stringify(layer));
	for (const profile of Array.isArray(copy?.profiles) ? copy.profiles : []) {
		if (profile && typeof profile === "object" && "password" in profile) profile.password = "••••••••";
	}
	return copy;
}

function descriptorOf(settings) {
	const found = (settings.describe({ redactSecrets: true }) ?? []).find((candidate) => candidate.ns === NAMESPACE);
	if (found === undefined) return undefined;
	return {
		value: redactDescriptorLayer(found.value),
		user: redactDescriptorLayer(found.user ?? {}),
		revision: found.revision,
		writable: true
	};
}

/**
* Register the /esxi/settings.get and /esxi/settings.save JSON routes. The
* webserver service is passed in by the caller (resolved through `ctx.inject`,
* which waits for availability).
* @returns true when routes were registered; false when no webserver exists
*   (e.g. headless profiles) — the plugin keeps working either way.
*/
export function registerSettingsRoutes(ctx, settings, webServer) {
	if (!webServer || typeof webServer.register !== "function") return false;
	const trustedHosts = () => ctx?.get?.("webRuntime")?.trustedHosts ?? [];
	const json = (response, status, body) => {
		response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
		response.end(JSON.stringify(body));
	};
	const pathnameOf = (request) => {
		try {
			return new URL(request.url ?? "/", "http://dsh.internal").pathname;
		} catch {
			return "/";
		}
	};
	const guard = (request, response, exactPath) => {
		if (pathnameOf(request) !== exactPath) {
			json(response, 404, { error: "not found" });
			return false;
		}
		if (request.method !== "POST") {
			json(response, 405, { error: "method not allowed" });
			return false;
		}
		if (!isTrustedApiRequest(request, trustedHosts())) {
			json(response, 403, { error: "untrusted origin" });
			return false;
		}
		return true;
	};
	const readBody = (request) => new Promise((resolve, reject) => {
		let data = "";
		request.on("data", (chunk) => {
			data += chunk;
			if (data.length > 1 << 20) {
				reject(new Error("body too large"));
				request.destroy();
			}
		});
		request.on("end", () => {
			try {
				resolve(data.length > 0 ? JSON.parse(data) : {});
			} catch {
				reject(new Error("invalid json body"));
			}
		});
		request.on("error", reject);
	});

	// POST-capable routes register as `kind: "prefix"` (the webserver rejects
	// non-GET on exact routes before the handler runs); the exact pathname is
	// enforced inside the guard instead. Registration rides the plugin fiber
	// when ctx.effect exists, and falls back to a direct registration for
	// effect-less contexts (tests, non-cordis harnesses).
	// 支持 POST 的路由必须以 `kind: "prefix"` 注册（web 服务器会在处理函数运行
	// 前拒绝 exact 路由上的非 GET 请求）；精确路径改为在 guard 内校验。注册在
	// 存在 ctx.effect 时挂到插件 fiber 上，否则直接注册（测试/非 cordis 环境）。
	const effect = typeof ctx?.effect === "function" ? ctx.effect : (callback) => {
		const disposer = callback();
		return typeof disposer === "function" ? disposer : () => {};
	};
	effect(() => webServer.register({
		kind: "prefix",
		path: "/esxi/settings.get",
		handler: async (request, response) => {
			if (!guard(request, response, "/esxi/settings.get")) return;
			const descriptor = descriptorOf(settings);
			if (descriptor === undefined) {
				json(response, 404, { error: "dsh-esxi settings namespace not registered" });
				return;
			}
			json(response, 200, descriptor);
		}
	}), "dsh-esxi: /esxi/settings.get route");
	effect(() => webServer.register({
		kind: "prefix",
		path: "/esxi/settings.save",
		handler: async (request, response) => {
			if (!guard(request, response, "/esxi/settings.save")) return;
			let body;
			try {
				body = await readBody(request);
			} catch (error) {
				json(response, 400, { error: error.message });
				return;
			}
			const ops = body?.ops;
			if (!Array.isArray(ops) || ops.length === 0) {
				json(response, 400, { error: "ops must be a non-empty array" });
				return;
			}
			const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : undefined;
			try {
				await applySettingsOps(settings, NAMESPACE, ops, expectedRevision);
				const descriptor = descriptorOf(settings);
				if (descriptor === undefined) {
					json(response, 404, { error: "dsh-esxi settings namespace not registered" });
					return;
				}
				json(response, 200, descriptor);
			} catch (error) {
				if (error?.name === "SettingsConflictError") json(response, 409, { error: "settings changed; retry" });
				else json(response, 400, { error: error instanceof Error ? error.message : String(error) });
			}
		}
	}), "dsh-esxi: /esxi/settings.save route");
	return true;
}
