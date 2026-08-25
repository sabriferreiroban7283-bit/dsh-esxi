// dsh-esxi core: validation, connection profiles, govc process runner, and
// output formatting. Deliberately imports ONLY Node builtins so the plugin
// resolves from any install location (registry, tarball, or a local file:
// link), independent of @deepseek-ai packages at import time.
// dsh-esxi 核心：参数校验、连接配置（profile）、govc 进程运行器与输出格式化。
// 刻意只导入 Node 内置模块，使插件可从任意安装位置（registry、tarball 或本地
// file: 链接）解析，导入期不依赖任何 @deepseek-ai 包。
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rename, rm, writeFile, stat, chmod } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { createWriteStream } from "node:fs";import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// Authentication failure latch: one rejected login per target URL halts
// further login attempts for 15 minutes (the typical ESXi account-lockout
// window). Retrying a stale stored password is what locks accounts — five
// failures do it on most hosts — so the runner fails fast with guidance
// instead of hammering the host.
// ─────────────────────────────────────────────────────────────────────────────
const authFailures = new Map();
const AUTH_LATCH_MS = 15 * 60 * 1000;
const AUTH_ERROR_MARKERS = [
	"incorrect user name or password",
	"cannot complete login",
	"cannot log in",
	"account.*locked",
	"login failed"
];
const AUTH_FAILURE_HINT = "esxi: the stored password was rejected by the host. STOP retrying — repeated attempts lock the ESXi account (usually 5 failures). Update the profile with the correct password via esxi_connect, then wait ~15 minutes for any lockout to clear before retrying.";

/** True when the target URL is inside the auth-failure latch window. */
export function isAuthLatched(url) {
	const stamped = authFailures.get(String(url ?? ""));
	if (stamped === undefined) return false;
	if (Date.now() - stamped > AUTH_LATCH_MS) {
		authFailures.delete(String(url ?? ""));
		return false;
	}
	return true;
}

/** Record a rejected login for the target URL (env URL), starting the latch. */
export function latchAuthFailure(env) {
	authFailures.set(String(env?.GOVC_URL ?? ""), Date.now());
}

/** Clear the latch for a URL — e.g. after esxi_connect stores a new password. */
export function clearAuthLatch(url) {
	authFailures.delete(String(url ?? ""));
}

const execFileP = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────────
// Argument validation (the harness does not auto-validate raw registrations)
// ─────────────────────────────────────────────────────────────────────────────
/** Validate `args` against a catalog parameter table. Throws on the first violation. */
export function validateArgs(params, args) {
	if (args === null || typeof args !== "object") throw new Error("invalid arguments: expected an object");
	for (const [key, spec] of Object.entries(params)) {
		if (spec.required && args[key] === undefined) throw new Error(`invalid arguments: missing required parameter "${key}"`);
		if (args[key] === undefined) continue;
		if (spec.enum && !spec.enum.includes(args[key])) throw new Error(`invalid arguments: "${key}" must be one of ${spec.enum.map((v) => JSON.stringify(v)).join(", ")}; got ${JSON.stringify(args[key])}`);
		const got = typeof args[key];
		if (spec.type === "string" && got !== "string") throw new Error(`invalid arguments: "${key}" must be a string`);
		if (spec.type === "boolean" && got !== "boolean") throw new Error(`invalid arguments: "${key}" must be a boolean`);
		if (spec.type === "number" && got !== "number") throw new Error(`invalid arguments: "${key}" must be a number`);
		if (spec.type === "integer" && (got !== "number" || !Number.isInteger(args[key]))) throw new Error(`invalid arguments: "${key}" must be an integer`);
		if (spec.type === "array") {
			if (!Array.isArray(args[key])) throw new Error(`invalid arguments: "${key}" must be an array`);
			for (const item of args[key]) {
				if (spec.items === "string" && typeof item !== "string") throw new Error(`invalid arguments: "${key}" must be an array of strings`);
				if (spec.items === "number" && typeof item !== "number") throw new Error(`invalid arguments: "${key}" must be an array of numbers`);
			}
		}
		if (spec.min !== undefined && typeof args[key] === "number" && args[key] < spec.min) throw new Error(`invalid arguments: "${key}" must be >= ${spec.min}`);
	}
}

/** Safe POSIX-ish tokenizer: honors double/single quotes and backslash escapes; never touches a shell. */
export function splitArgs(input) {
	if (typeof input !== "string") throw new Error("invalid args: expected a string");
	if (input.length === 0) throw new Error("invalid args: empty command line");
	const out = [];
	let cur = "";
	let inCur = false;
	let quote = null;
	let escaped = false;
	for (const ch of input) {
		if (escaped) {
			cur += ch;
			escaped = false;
			inCur = true;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote !== null) {
			if (ch === quote) {
				quote = null;
			} else {
				cur += ch;
			}
			continue;
		}
		if (ch === "\"" || ch === "'") {
			quote = ch;
			inCur = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (inCur) {
				out.push(cur);
				cur = "";
				inCur = false;
			}
			continue;
		}
		cur += ch;
		inCur = true;
	}
	if (escaped) cur += "\\";
	if (quote !== null) throw new Error("invalid args: unterminated quote");
	if (inCur) out.push(cur);
	if (out.length === 0) throw new Error("invalid args: empty command line");
	return out;
}

/** Brief single-line summary of an argv for error messages and labels. */
export function describePlan(argv) {
	const head = argv.slice(0, 6).join(" ");
	return argv.length > 6 ? `${head} … (${argv.length} args)` : head;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection profiles (file store + credentials seam)
// ─────────────────────────────────────────────────────────────────────────────
export function passwordRefFor(name) {
	const sanitized = String(name).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "DEFAULT";
	return `ESXI_PASSWORD_${sanitized}`;
}

/** Normalize a connection URL for govc: scheme + /sdk path defaults. */
export function normalizeUrl(raw) {
	let url = String(raw ?? "").trim();
	if (url.length === 0) throw new Error("invalid profile: url is required");
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(url)) url = `https://${url}`;
	try {
		const parsed = new URL(url);
		if (parsed.pathname === "" || parsed.pathname === "/") parsed.pathname = "/sdk";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		throw new Error(`invalid profile: url "${raw}" is not parseable`);
	}
}

/** Resolve a path under the DeepSeek Harness home (DSH_HOME or ~/.dsh). */
export function dshHomePath(...segments) {
	const home = process.env.DSH_HOME || join(homedir(), ".dsh");
	return join(home, ...segments);
}

export class ProfileStore {
	constructor(file) {
		this.file = file;
		this.data = { version: 1, default: null, profiles: {} };
	}

	async load() {
		let text;
		try {
			text = await readFile(this.file, "utf8");
		} catch (error) {
			if (error?.code === "ENOENT") return;
			throw error;
		}
		try {
			const parsed = JSON.parse(text);
			if (!parsed || typeof parsed !== "object" || typeof parsed.profiles !== "object") {
				throw new Error("invalid document shape");
			}
			this.data = {
				version: 1,
				default: typeof parsed.default === "string" ? parsed.default : null,
				profiles: parsed.profiles
			};
		} catch (error) {
			throw new Error(`esxi: cannot read connection profiles from ${this.file}: ${error.message}. Fix or delete the file and reconnect.`);
		}
	}

	async save() {
		await mkdir(join(this.file, ".."), { recursive: true, mode: 0o700 });
		// Profiles managed by the settings panel live in the settings document
		// (settings.yaml), not in the profiles file — never persist them here.
		const profiles = {};
		for (const [name, profile] of Object.entries(this.data.profiles)) {
			if (!profile?.settingsManaged) profiles[name] = profile;
		}
		const tmp = `${this.file}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
		await writeFile(tmp, JSON.stringify({ version: 1, default: this.data.default, profiles }, null, 2) + "\n", { mode: 0o600 });
		await rename(tmp, this.file);
	}

	names() {
		return Object.keys(this.data.profiles).sort();
	}

	get(name) {
		return this.data.profiles[name];
	}

	profileOrThrow(name) {
		const profile = this.data.profiles[name];
		if (!profile) throw new Error(`esxi: unknown connection profile "${name}" (known: ${this.names().join(", ") || "none"})`);
		return profile;
	}

	defaultName() {
		const name = this.data.default;
		return name !== null && this.data.profiles[name] ? name : undefined;
	}

	upsert(name, profile) {
		const first = Object.keys(this.data.profiles).length === 0;
		this.data.profiles[name] = profile;
		if (this.data.default === null || this.data.default === name || first) this.data.default = name;
	}

	remove(name) {
		delete this.data.profiles[name];
		if (this.data.default === name) this.data.default = Object.keys(this.data.profiles)[0] ?? null;
	}

	setDefault(name) {
		this.profileOrThrow(name);
		this.data.default = name;
	}
}

/** Resolve the password for one profile call: an inline secret (settings-managed
*  profiles carry it in memory) wins, then the harness credentials seam. */
export async function resolvePassword(ctx, profile) {
	if (profile?.password) return profile.password;
	if (!profile?.passwordRef) return undefined;
	const credentials = ctx?.get?.("credentials");
	if (credentials === undefined || typeof credentials.resolve !== "function") return undefined;
	const hit = await credentials.resolve(profile.passwordRef);
	return hit?.value;
}

/**
* Build the GOVC_* environment for one invocation. With a profile, profile
* fields win over the process environment; without one (env mode) the
* inherited GOVC_* variables are left untouched.
*/
export function buildEnv(profile, { password, extra = {} } = {}) {
	const env = { ...process.env };
	if (profile) {
		env.GOVC_URL = profile.url;
		if (profile.username) env.GOVC_USERNAME = profile.username;
		if (password) env.GOVC_PASSWORD = password;
		env.GOVC_INSECURE = profile.insecure ? "true" : "false";
		if (profile.datacenter) env.GOVC_DATACENTER = profile.datacenter;
		if (profile.folder) env.GOVC_FOLDER = profile.folder;
		if (profile.tlsCaCerts) env.GOVC_TLS_CA_CERTS = profile.tlsCaCerts;
	}
	return { ...env, ...extra };
}

/** Resolve which profile a call runs against; throws a model-actionable error when none exists. */
export function resolveProfileForCall(store, args) {
	const explicit = args?.profile;
	if (explicit !== undefined && explicit !== "") {
		return { profile: store.profileOrThrow(explicit), name: explicit };
	}
	const name = store.defaultName();
	if (name !== undefined) return { profile: store.get(name), name };
	if (process.env.GOVC_URL) return { profile: null, name: undefined };
	throw new Error("esxi: no connection profile is configured. Run esxi_connect first, or set GOVC_URL / GOVC_USERNAME / GOVC_PASSWORD in the environment (env mode).");
}

/** Human label of the resolved connection target, used in approval reasons and messages. */
export function profileLabel(resolved) {
	return resolved.name !== undefined ? `profile "${resolved.name}"` : "environment (GOVC_* variables)";
}

// ─────────────────────────────────────────────────────────────────────────────
// govc process runner
// ─────────────────────────────────────────────────────────────────────────────
export class EsxiCommandError extends Error {
	constructor(message, { exitCode, stdout, stderr, command }) {
		super(message);
		this.name = "EsxiCommandError";
		this.exitCode = exitCode;
		this.stdout = stdout;
		this.stderr = stderr;
		this.command = command;
	}
}

/**
* Run one govc invocation. Resolves `govcPath` (absolute or PATH), applies the
* timeout and maxBuffer, and shapes failures into an EsxiCommandError whose
* message the model can act on.
*/
export async function runGovc(govcPath, argv, { env, timeoutMs = 120000, maxBufferBytes = 64 * 1024 * 1024 } = {}) {
	let stdout = "";
	let stderr = "";
	// Fail fast while a previous login was rejected for this target: retrying a
	// stale stored password is what locks ESXi accounts (5 failures, typically).
	if (isAuthLatched(env?.GOVC_URL)) throw new Error(AUTH_FAILURE_HINT);
	try {
		const result = await execFileP(govcPath, argv, {
			env,
			timeout: timeoutMs,
			maxBuffer: maxBufferBytes,
			windowsHide: true
		});
		stdout = result.stdout ?? "";
		stderr = result.stderr ?? "";
	} catch (error) {
		// A rejected login latches the target so later calls stop trying it
		// (see the latch above); the error surfaces the guidance too.
		const authDetail = ((error.stderr ?? "") + " " + (error.stdout ?? "")).trim();
		if (AUTH_ERROR_MARKERS.some((marker) => new RegExp(marker, "i").test(authDetail))) {
			latchAuthFailure(env);
			throw new Error(`${AUTH_FAILURE_HINT} (${authDetail.slice(0, 200)})`);
		}
		// The harness host occasionally loses the installed govc binary; recover
		// transparently by re-installing it once and retrying the same command.
		if (error.code === "ENOENT") {
			try {
				// Prefer a stable install dir over the caller's (possibly bare)
				// govcPath dir, and RETRY WITH THE INSTALLED BINARY — a bare
				// "govc" path stays unresolvable even after installation.
				const installDir = dirname(govcPath) === "." ? join(dshHomePath(), "esxi", "bin") : dirname(govcPath);
				const installed = await installGovc(installDir);
				const retryPath = installed?.binary ?? govcPath;
				const result = await execFileP(retryPath, argv, {
					env,
					timeout: timeoutMs,
					maxBuffer: maxBufferBytes,
					windowsHide: true
				});
				return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
			} catch {
				/* fall through to the original error */
			}
		}
		stdout = error.stdout ?? "";
		stderr = error.stderr ?? "";
		const timedOut = error.killed === true || error.signal === "SIGTERM" || error.code === "ETIMEDOUT";
		const marker = timedOut ? `[timed out after ${timeoutMs}ms]` : `[exit code: ${error.code ?? "?"}]`;
		const detail = (stderr || "").trim() || (stdout || "").trim() || error.message;
		throw new EsxiCommandError(`govc ${describePlan(argv)} failed: ${detail} ${marker}`, {
			exitCode: typeof error.code === "number" ? error.code : undefined,
			stdout,
			stderr,
			command: describePlan(argv)
		});
	}
	return { stdout, stderr };
}

/**
* Run a local (non-govc) command — used for post-processing steps such as
* bundling an exported OVF directory into an OVA with `tar`. Same failure
* shaping as {@link runGovc}.
*/
export async function runLocal(argv, { timeoutMs = 600000, maxBufferBytes = 64 * 1024 * 1024 } = {}) {
	try {
		const result = await execFileP(argv[0], argv.slice(1), {
			timeout: timeoutMs,
			maxBuffer: maxBufferBytes,
			windowsHide: true
		});
		return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
	} catch (error) {
		const marker = error.code === "ETIMEDOUT" ? `[timed out after ${timeoutMs}ms]` : `[exit code: ${error.code ?? "?"}]`;
		const detail = (error.stderr || "").trim() || error.message;
		throw new EsxiCommandError(`local command ${describePlan(argv)} failed: ${detail} ${marker}`, {
			exitCode: typeof error.code === "number" ? error.code : undefined,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			command: describePlan(argv)
		});
	}
}

/** Bound a tool's model-visible output, with a spill notice like the bash tool. */
export function truncateOutput(text, maxChars) {
	if (typeof text !== "string") text = String(text ?? "");
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n[output truncated; full output is ${text.length} characters — run the same command with more specific filters to narrow it]`;
}

/** Pretty-print a JSON value that failed to parse as an error hint, not a crash. */
export function tryParseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export function fmtBytes(bytes) {
	if (typeof bytes !== "number" || !Number.isFinite(bytes)) return "?";
	const units = ["B", "KB", "MB", "GB", "TB", "PB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// govc -json formatters (defensive; raw text fallback on parse failure).
// Field access goes through `look`, which accepts BOTH the historical
// PascalCase keys emitted by older govc CLI versions and the lowercase-first
// API keys emitted by govc 0.52+ (`-json` now mirrors the SOAP property
// casing: `virtualMachines`, `runtime.powerState`, `config.numCPU`…).
// ─────────────────────────────────────────────────────────────────────────────
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (typeof v === "number" ? v : undefined);
/** First defined property among the given candidate keys (case-tolerant). */
const look = (obj, ...keys) => {
	if (obj === null || typeof obj !== "object") return undefined;
	for (const key of keys) {
		if (obj[key] !== undefined) return obj[key];
	}
	return undefined;
};

/** `govc vm.info -json` → compact per-VM table. */
export function formatVmInfoJson(raw) {
	const doc = tryParseJson(raw);
	const vms = look(doc, "VirtualMachines", "virtualMachines");
	if (!Array.isArray(vms)) return undefined;
	const rows = vms.map((vm) => {
		const runtime = look(vm, "Runtime", "runtime") ?? {};
		const config = look(vm, "Config", "config") ?? {};
		const guest = look(vm, "Guest", "guest") ?? {};
		const host = look(runtime, "Host", "host") ?? {};
		const datastores = (look(vm, "Datastore", "datastore") ?? []).map((d) => str(look(d, "Name", "name"))).join(",");
		const networks = (look(vm, "Network", "network") ?? []).map((n) => str(look(n, "Name", "name"))).join(",");
		return [
			str(look(vm, "Name", "name")),
			str(look(runtime, "PowerState", "powerState")) || "?",
			str(look(runtime, "ConnectionState", "connectionState")) || "",
			String(num(look(config, "NumCpu", "numCPU", "numCpu")) ?? "?"),
			String(num(look(config, "MemorySizeMB", "memorySizeMB")) ?? "?"),
			str(look(guest, "IpAddress", "ipAddress")) || "-",
			str(look(guest, "HostName", "hostName")) || "-",
			str(look(host, "Name", "name")) || "-",
			str(look(guest, "ToolsStatus", "toolsStatus")) || "-",
			datastores,
			networks
		];
	});
	const header = ["NAME", "POWER", "CONN", "CPU", "MEM(MB)", "IP", "HOSTNAME", "HOST", "TOOLS", "DATASTORES", "NETWORKS"];
	return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

/** `govc host.info -json` → compact per-host table. */
export function formatHostInfoJson(raw) {
	const doc = tryParseJson(raw);
	const hosts = look(doc, "HostSystems", "hostSystems");
	if (!Array.isArray(hosts)) return undefined;
	const rows = hosts.map((host) => {
		const summary = look(host, "Summary", "summary") ?? {};
		const runtime = look(host, "Runtime", "runtime") ?? {};
		const product = look(look(summary, "Config", "config") ?? {}, "Product", "product") ?? {};
		const hardware = look(summary, "Hardware", "hardware") ?? {};
		const quick = look(summary, "QuickStats", "quickStats") ?? {};
		return [
			str(look(host, "Name", "name")),
			str(look(runtime, "ConnectionState", "connectionState")) || "?",
			str(look(runtime, "PowerState", "powerState")) || "?",
			look(runtime, "InMaintenanceMode", "inMaintenanceMode") ? "yes" : "no",
			str(look(product, "Name", "name")) || "-",
			str(look(product, "Version", "version")) || "-",
			str(look(product, "Build", "build")) || "-",
			str(look(hardware, "CpuModel", "cpuModel")) || "-",
			String(num(look(hardware, "NumCpuCores", "numCpuCores")) ?? "?"),
			fmtBytes(num(look(hardware, "MemorySize", "memorySize")) ?? NaN),
			`${num(look(quick, "OverallCpuUsage", "overallCpuUsage")) ?? "?"}%`
		];
	});
	const header = ["NAME", "CONN", "POWER", "MAINT", "PRODUCT", "VERSION", "BUILD", "CPU", "CORES", "MEM", "CPU%"];
	return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

/** `govc datastore.info -json` → capacity table. */
export function formatDatastoreInfoJson(raw) {
	const doc = tryParseJson(raw);
	const datastores = look(doc, "Datastores", "datastores");
	if (!Array.isArray(datastores)) return undefined;
	const rows = datastores.map((ds) => {
		const summary = look(ds, "Summary", "summary") ?? {};
		const capacity = num(look(summary, "Capacity", "capacity")) ?? 0;
		const free = num(look(summary, "FreeSpace", "freeSpace")) ?? 0;
		const used = capacity > 0 ? Math.round(((capacity - free) / capacity) * 100) : 0;
		return [str(look(summary, "Name", "name")), str(look(summary, "Type", "type")) || "?", fmtBytes(capacity), fmtBytes(free), `${used}%`, str(look(summary, "Url", "url")) || ""];
	});
	const header = ["NAME", "TYPE", "CAPACITY", "FREE", "USED", "URL"];
	return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

/** `govc pool.info -json` → per-pool allocation table. */
export function formatPoolInfoJson(raw) {
	const doc = tryParseJson(raw);
	const pools = look(doc, "ResourcePools", "resourcePools");
	if (!Array.isArray(pools)) return undefined;
	const rows = pools.map((pool) => {
		const cfg = look(look(pool, "Summary", "summary") ?? {}, "Config", "config") ?? {};
		const cpu = look(cfg, "CpuAllocation", "cpuAllocation") ?? {};
		const mem = look(cfg, "MemoryAllocation", "memoryAllocation") ?? {};
		return [
			str(look(pool, "Name", "name")),
			String(num(look(cpu, "Limit", "limit")) ?? "?"),
			String(num(look(cpu, "Reservation", "reservation")) ?? "?"),
			str(look(look(cpu, "Shares", "shares") ?? {}, "Level", "level")) || "?",
			String(num(look(mem, "Limit", "limit")) ?? "?"),
			String(num(look(mem, "Reservation", "reservation")) ?? "?"),
			str(look(look(mem, "Shares", "shares") ?? {}, "Level", "level")) || "?"
		];
	});
	const header = ["POOL", "CPU_LIMIT(MHz)", "CPU_RES(MHz)", "CPU_SHARES", "MEM_LIMIT(MB)", "MEM_RES(MB)", "MEM_SHARES"];
	return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

/** `govc permissions.ls -json` → principal/role table. */
export function formatPermissionsJson(raw) {
	const doc = tryParseJson(raw);
	if (!Array.isArray(doc)) return undefined;
	const rows = doc.map((p) => {
		const entity = look(p, "Entity", "entity") ?? {};
		return [str(look(p, "Principal", "principal")), str(look(p, "Role", "role")), look(p, "Propagate", "propagate") ? "yes" : "no", `${str(look(entity, "Type", "type"))}:${str(look(entity, "Value", "value"))}`];
	});
	const header = ["PRINCIPAL", "ROLE", "PROPAGATE", "ENTITY"];
	return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

/** `govc role.ls -json` → role table. */
export function formatRolesJson(raw) {
	const doc = tryParseJson(raw);
	if (!Array.isArray(doc)) return undefined;
	const rows = doc.map((role) => [str(look(role, "Name", "name")), String((look(role, "Privilege", "privilege") ?? []).length)]);
	const header = ["ROLE", "PRIVILEGES"];
	return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

/** `govc license.ls -json` → license table. */
export function formatLicensesJson(raw) {
	const doc = tryParseJson(raw);
	if (!Array.isArray(doc)) return undefined;
	const rows = doc.map((license) => [str(look(license, "LicenseKey", "licenseKey")), str(look(license, "Name", "name")), String(num(look(license, "Total", "total")) ?? "?"), String(num(look(license, "Used", "used")) ?? "?"), str(look(license, "EditionKey", "editionKey")) || ""]);
	const header = ["KEY", "NAME", "TOTAL", "USED", "EDITION"];
	return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

/** `govc tags.ls -json` + category names → grouped tag list. */
export function formatTagsJson(rawTags, rawCategories) {
	const tags = tryParseJson(rawTags);
	if (!Array.isArray(tags)) return undefined;
	const categories = tryParseJson(rawCategories);
	const byId = {};
	if (Array.isArray(categories)) {
		for (const category of categories) byId[str(look(category, "Id", "id"))] = str(look(category, "Name", "name"));
	}
	const lines = tags.map((tag) => `${byId[str(look(tag, "CategoryID", "categoryID", "categoryId"))] || str(look(tag, "CategoryID", "categoryID", "categoryId"))}\t${str(look(tag, "Name", "name"))}`);
	return lines.length > 0 ? `CATEGORY\tTAG\n${lines.join("\n")}` : "(no tags)";
}

/** `govc library.ls -json` → library/item table. */
export function formatLibrariesJson(raw) {
	const doc = tryParseJson(raw);
	if (!Array.isArray(doc)) return undefined;
	const rows = doc.map((entry) => {
		const kind = look(entry, "Kind", "kind");
		return [str(look(entry, "Name", "name")), kind !== undefined ? String(kind) : "", str(look(entry, "ID", "id"))];
	});
	const header = ["NAME", "KIND", "ID"];
	return [header.join("\t"), ...rows.map((r) => r.join("\t"))].join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// govc bootstrap (esxi_doctor)
// ─────────────────────────────────────────────────────────────────────────────
function platformAssetNames() {
	const os = process.platform;
	const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : undefined;
	const candidates = [];
	if (os === "linux" || os === "darwin") {
		const OS = os === "darwin" ? "Darwin" : "Linux";
		const arch2 = process.arch === "x64" ? "x86_64" : "arm64";
		// legacy single-binary gzip first, then the current tar.gz naming
		candidates.push({ url: `govc_${os}_${arch}.gz`, kind: "gz" });
		candidates.push({ url: `govc_${OS}_${arch2}.tar.gz`, kind: "tar.gz" });
	} else if (os === "win32") {
		candidates.push({ url: `govc_windows_${arch}.exe.gz`, kind: "exe.gz" });
	}
	return candidates;
}

/** Download and install the official govc binary into installDir. Returns the final binary path. */
export async function installGovc(installDir, { logger = console } = {}) {
	const candidates = platformAssetNames();
	if (candidates.length === 0) throw new Error("govc auto-install is not supported on this platform; download the binary manually from https://github.com/vmware/govmomi/releases");
	await mkdir(installDir, { recursive: true, mode: 0o700 });
	let lastError;
	for (const candidate of candidates) {
		const url = `https://github.com/vmware/govmomi/releases/latest/download/${candidate.url}`;
		const tmpGz = join(installDir, `.govc-download-${process.pid}.${candidate.kind.replace(".", "-")}`);
		const tmpBin = join(installDir, `.govc-installing`);
		try {
			logger.info(`esxi: downloading ${url}`);
			const response = await fetch(url, { redirect: "follow" });
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const buffer = Buffer.from(await response.arrayBuffer());
			if (candidate.kind === "gz" || candidate.kind === "exe.gz") {
				await new Promise((resolve, reject) => {
					const gunzip = createGunzip();
					const out = createWriteStream(tmpBin);
					gunzip.on("error", reject);
					out.on("error", reject);
					out.on("finish", resolve);
					gunzip.pipe(out);
					gunzip.end(buffer);
				});
			} else {
				await writeFile(tmpGz, buffer);
				await execFileP("tar", ["-xzf", tmpGz, "-C", installDir, "govc"]);
				await rm(tmpGz, { force: true });
			}
			const binary = join(installDir, process.platform === "win32" ? "govc.exe" : "govc");
			if (candidate.kind !== "tar.gz") {
				await rename(tmpBin, binary);
			}
			await chmod(binary, 0o755);
			const version = await execFileP(binary, ["version"], { timeout: 30000 }).then((r) => r.stdout.trim()).catch(() => "(version check failed)");
			return { binary, version, url };
		} catch (error) {
			lastError = error;
			await rm(tmpGz, { force: true }).catch(() => {});
			await rm(tmpBin, { force: true }).catch(() => {});
			logger.warn(`esxi: govc download failed for ${candidate.url}: ${error.message}`);
		}
	}
	throw new Error(`esxi: could not download govc (${lastError?.message ?? "unknown error"}). Install it manually from https://github.com/vmware/govmomi/releases and set the plugin config govcPath.`);
}
