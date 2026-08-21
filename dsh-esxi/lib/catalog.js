// dsh-esxi tool catalog: every esxi_* tool as data — parameter schema, govc
// argv builder (flags BEFORE positionals — Go's flag package stops at the
// first positional), optional JSON formatter, optional approval gate, and an
// optional `custom` executor for store-manipulating and multi-command tools.
// The catalog never imports the harness; index.js registers it.
// dsh-esxi 工具目录：每个 esxi_* 工具都以数据描述——参数 schema、govc argv
// 构造器（标志必须位于位置参数之前——Go 的 flag 包在首个位置参数处停止解析）、
// 可选的 JSON 格式化器、可选的审批门，以及用于操作存储/多命令工具的 `custom`
// 执行器。本文件不导入任何 harness 模块；由 index.js 完成注册。
import {
	buildEnv,
	dshHomePath,
	formatDatastoreInfoJson,
	formatHostInfoJson,
	formatLibrariesJson,
	formatLicensesJson,
	formatPermissionsJson,
	formatPoolInfoJson,
	formatRolesJson,
	formatTagsJson,
	formatVmInfoJson,
	installGovc,
	normalizeUrl,
	passwordRefFor,
	resolvePassword,
	resolveProfileForCall,
	runGovc,
	runLocal,
	splitArgs,
	truncateOutput,
	validateArgs
} from "./core.js";
import { autoinstallMetaData, autoinstallUserData, buildSeedIso, sha512crypt } from "./seediso.js";
import { flatDescriptor, parseSparseHeader, sparseVmdkToRaw } from "./vmdk.js";
import { open, rm, readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Compact schema-prop helper: type, description, optional {required, enum, items, min, max}. */
const S = (type, description, opts = {}) => ({ type, description, ...opts });

const PROFILE_PARAM = S("string", "Connection profile name. Omit to use the default profile or GOVC_* environment variables.");
const INFO_CAP = S("integer", "Maximum number of objects to enrich with details in one call (default from plugin config).", { min: 1 });

/** Split a comma-separated parameter into non-empty trimmed tokens. */
function splitCsv(value) {
	if (value === undefined || value === null) return [];
	return String(value).split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Random 16-char sha512crypt salt. */
function genSalt() {
	return randomBytes(16).toString("base64").replaceAll("+", ".").slice(0, 16);
}

/**
* Resolve a VM's (first) datastore via `vm.info -json`, so tools that need a
* datastore can default to the VM's own instead of failing on govc's ambiguous
* default-datastore resolution.
*/
async function vmDatastore(config, env, vm) {
	const result = await runGovc(config.govcPath, ["vm.info", "-json", vm], { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes });
	const doc = JSON.parse(result.stdout);
	const urls = doc?.virtualMachines?.[0]?.config?.datastoreUrl ?? [];
	if (urls.length === 0) throw new Error(`could not determine the datastore of VM "${vm}"; pass datastore explicitly`);
	if (urls.length > 1) throw new Error(`VM "${vm}" spans multiple datastores (${urls.map((u) => u.name).join(", ")}); pass datastore explicitly`);
	return urls[0].name;
}

/** Run the standard single-command path for a catalog tool. */
export async function runTool(ctx, config, store, def, args) {
	validateArgs(def.params, args);
	const resolved = resolveProfileForCall(store, args);
	const built = def.build(args, resolved);
	const argv = built.argv;
	if (!Array.isArray(argv) || argv.length === 0) throw new Error(`internal error: tool "${def.name}" produced an empty command`);
	const password = await resolvePassword(ctx, resolved.profile);
	const env = buildEnv(resolved.profile, { password, extra: built.env });
	const timeoutMs = built.timeoutMs ?? (def.long ? config.longTimeoutMs : config.defaultTimeoutMs);
	const result = await runGovc(config.govcPath, argv, {
		env,
		timeoutMs,
		maxBufferBytes: config.maxOutputBytes
	});
	let text = result.stdout;
	if (def.format) {
		const formatted = def.format([result.stdout], args);
		if (formatted !== undefined) text = formatted;
	}
	if (text === undefined || text.length === 0) text = "(no output)";
	return { kind: "ok", text: truncateOutput(text, config.maxOutputChars) };
}

/** Run several govc commands (typically in parallel) against the same connection. */
async function runGovcBatch(ctx, config, store, def, args, commands) {
	const resolved = resolveProfileForCall(store, args);
	const password = await resolvePassword(ctx, resolved.profile);
	const env = buildEnv(resolved.profile, { password });
	return Promise.all(commands.map(async (argv) => {
		if (!Array.isArray(argv) || argv.length === 0) return { stdout: "" };
		return runGovc(config.govcPath, argv, {
			env,
			timeoutMs: def.long ? config.longTimeoutMs : config.defaultTimeoutMs,
			maxBufferBytes: config.maxOutputBytes
		});
	}));
}

export const TOOLS = [
	// ─────────────────────────────────────────────────────────────────────────
	// Profiles & environment
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_connect",
		description: "Create or update a connection profile for a vCenter Server or ESXi host. The password is stored in the harness credentials store (never in the profiles file). Subsequent esxi_* calls target this profile (or the default).",
		params: {
			profile: S("string", "Name of the connection profile.", { required: true }),
			url: S("string", "vCenter Server or ESXi host — host name or IP is fine; normalized to https://<host>/sdk.", { required: true }),
			username: S("string", "Account with API access, e.g. administrator@vsphere.local or root for a standalone host.", { required: true }),
			password: S("string", "Password. Stored through the harness credentials store unless the credential ref already resolves."),
			insecure: S("boolean", "Skip TLS certificate verification (default true)."),
			datacenter: S("string", "Default datacenter, e.g. DC1 (sets GOVC_DATACENTER)."),
			folder: S("string", "Default inventory folder (sets GOVC_FOLDER)."),
			tlsCaCerts: S("string", "Path to a CA bundle to trust instead of skipping verification."),
			setDefault: S("boolean", "Make this the default profile (default true when none is set)."),
			verify: S("boolean", "Immediately verify connectivity with govc about.")
		},
		custom: async function esxiConnect(ctx, config, store, args) {
			validateArgs(this.params, args);
			const credentials = ctx.get?.("credentials");
			const url = normalizeUrl(args.url);
			const passwordRef = passwordRefFor(args.profile);
			if (args.password) {
				if (!credentials || typeof credentials.set !== "function") {
					throw new Error("esxi_connect: the harness credentials service is unavailable; cannot store the password safely. Load @deepseek-ai/dsh-credentials-local.");
				}
				await credentials.set(passwordRef, args.password);
			}
			const record = {
				url,
				username: args.username,
				insecure: args.insecure ?? true,
				passwordRef,
				...(args.datacenter ? { datacenter: args.datacenter } : {}),
				...(args.folder ? { folder: args.folder } : {}),
				...(args.tlsCaCerts ? { tlsCaCerts: args.tlsCaCerts } : {})
			};
			store.upsert(args.profile, record);
			if (args.setDefault === true || store.defaultName() === undefined) store.setDefault(args.profile);
			await store.save();
			const lines = [
				`Connected profile "${args.profile}":`,
				`  url: ${url}`,
				`  username: ${args.username}`,
				`  insecure: ${record.insecure}`,
				...(record.datacenter ? [`  datacenter: ${record.datacenter}`] : []),
				...(record.folder ? [`  folder: ${record.folder}`] : []),
				`  default: ${store.defaultName() === args.profile ? "yes" : "no"}`,
				`  password: ${args.password ? "stored" : "kept from earlier connect / credential store"}`
			];
			let text = lines.join("\n");
			if (args.verify) {
				let password = args.password;
				if (!password && credentials && typeof credentials.resolve === "function") {
					const hit = await credentials.resolve(passwordRef);
					password = hit?.value;
				}
				try {
					const about = await runGovc(config.govcPath, ["about"], {
						env: buildEnv(record, { password }),
						timeoutMs: config.defaultTimeoutMs,
						maxBufferBytes: config.maxOutputBytes
					});
					text += `\n\nConnectivity check (govc about):\n${about.stdout.trim()}`;
				} catch (error) {
					text += `\n\nConnectivity check FAILED: ${error.message}`;
				}
			} else {
				text += "\n\nRun esxi_about to verify connectivity.";
			}
			return { kind: "ok", text: truncateOutput(text, config.maxOutputChars) };
		}
	},
	{
		name: "esxi_disconnect",
		description: "Delete a connection profile and optionally unset its stored credential. The remote system is not touched.",
		params: {
			profile: S("string", "Profile name to delete.", { required: true }),
			keepSecret: S("boolean", "Keep the stored password (default false — the credential is unset).")
		},
		custom: async function esxiDisconnect(ctx, config, store, args) {
			validateArgs(this.params, args);
			const profile = store.get(args.profile);
			if (!profile) throw new Error(`esxi: unknown connection profile "${args.profile}"`);
			store.remove(args.profile);
			await store.save();
			const lines = [`Disconnected profile "${args.profile}".`];
			if (!args.keepSecret && profile.passwordRef) {
				const credentials = ctx.get?.("credentials");
				if (credentials && typeof credentials.unset === "function") {
					await credentials.unset(profile.passwordRef);
					lines.push("Stored password was removed.");
				}
			} else if (args.keepSecret) {
				lines.push("Stored password kept.");
			}
			const remaining = store.names();
			lines.push(remaining.length > 0 ? `Remaining profiles: ${remaining.join(", ")}` : "No profiles remain — reconnect with esxi_connect or use GOVC_* environment variables.");
			return { kind: "ok", text: lines.join("\n") };
		}
	},
	{
		name: "esxi_profiles",
		description: "List configured connection profiles (url, username, datacenter, default). Passwords are never shown.",
		params: {},
		custom: async function esxiProfiles(ctx, config, store) {
			const names = store.names();
			const defaultName = store.defaultName();
			const credentials = ctx.get?.("credentials");
			const lines = [];
			if (names.length === 0) {
				lines.push("No connection profiles configured.");
			} else {
				lines.push("Connection profiles:");
				for (const name of names) {
					const profile = store.get(name);
					let secret = "no stored password";
					if (profile.password) {
						secret = "stored";
					} else if (profile.passwordRef && credentials && typeof credentials.describe === "function") {
						const described = await credentials.describe(profile.passwordRef);
						secret = described?.configured ? "stored" : "not set";
					}
					const source = profile.settingsManaged ? " (settings)" : "";
					const parts = [
						`url=${profile.url}`,
						`username=${profile.username}`,
						`insecure=${profile.insecure}`,
						...(profile.datacenter ? [`datacenter=${profile.datacenter}`] : []),
						...(profile.folder ? [`folder=${profile.folder}`] : []),
						`password=${secret}`
					];
					lines.push(`  ${name}${name === defaultName ? " (default)" : ""}${source}: ${parts.join(", ")}`);
				}
			}
			if (process.env.GOVC_URL) lines.push("Environment mode is available (GOVC_URL set): calls without a profile use GOVC_* variables.");
			return { kind: "ok", text: lines.join("\n") };
		}
	},
	{
		name: "esxi_set_default",
		description: "Switch the default connection profile used by every esxi_* tool.",
		params: {
			profile: S("string", "Profile name to make the default.", { required: true })
		},
		custom: async function esxiSetDefault(ctx, config, store, args) {
			validateArgs(this.params, args);
			store.setDefault(args.profile);
			await store.save();
			return { kind: "ok", text: `Default profile is now "${args.profile}".` };
		}
	},
	{
		name: "esxi_about",
		description: "Connect to the target and report its identity: product name, vendor, version, build, OS type (govc about). Good first connectivity check.",
		params: {
			profile: PROFILE_PARAM
		},
		build(args, resolved) {
			return { argv: ["about"] };
		}
	},
	{
		name: "esxi_doctor",
		description: "Diagnose the plugin runtime: locate the govc binary (config govcPath or PATH), download and install the official govc release binary when missing (install: true), and verify connectivity to a profile with govc about.",
		params: {
			profile: PROFILE_PARAM,
			install: S("boolean", "Download and install the official govc binary into the install dir when missing."),
			installDir: S("string", "Directory to install govc into (default: <dsh home>/esxi/bin).")
		},
		custom: async function esxiDoctor(ctx, config, store, args) {
			validateArgs(this.params, args);
			const lines = [];
			let binary = config.govcPath;
			let versionText = null;
			try {
				const probe = await runGovc(binary, ["version"], {
					env: process.env,
					timeoutMs: 30000,
					maxBufferBytes: 1 << 20
				});
				versionText = probe.stdout.trim() || "(no version output)";
			} catch (error) {
				versionText = null;
				lines.push(`govc not runnable at "${binary}": ${error.message.split("\n")[0]}`);
			}
			if (versionText !== null) {
				lines.push(`govc binary: ${binary}`);
				lines.push(`govc version: ${versionText}`);
			} else if (args.install) {
				const installDir = args.installDir ?? config.installDir ?? dshHomePath("esxi", "bin");
				lines.push(`Installing govc into ${installDir} …`);
				try {
					const installed = await installGovc(installDir, { logger: ctx.logger });
					binary = installed.binary;
					lines.push(`Installed ${installed.binary} (${installed.version}).`);
					// Adopt the installed binary for this session when the configured
					// govcPath is still the PATH default (not an explicit path).
					const explicitPath = config.govcPath.includes("/") || config.govcPath.includes("\\");
					if (!explicitPath) {
						config.govcPath = installed.binary;
						lines.push(`govcPath now uses the installed binary for this session (${installed.binary}).`);
					} else {
						lines.push(`The session still uses govcPath "${config.govcPath}"; update the plugin config or the settings panel to point at ${installed.binary}.`);
					}
				} catch (error) {
					lines.push(`govc installation failed: ${error.message}`);
					lines.push("Install manually from https://github.com/vmware/govmomi/releases and set govcPath.");
				}
			} else {
				lines.push("govc is required. Install it (see https://github.com/vmware/govmomi/releases), set plugin config govcPath, or re-run with install: true to download the official binary.");
			}
			if (args.profile !== undefined || store.defaultName() !== undefined) {
				const resolved = resolveProfileForCall(store, args);
				lines.push(`Target: ${resolved.name !== undefined ? `profile "${resolved.name}"` : "GOVC_* environment"}`);
				if (versionText !== null) {
					try {
						const password = await resolvePassword(ctx, resolved.profile);
						const env = buildEnv(resolved.profile, { password });
						const about = await runGovc(binary, ["about"], {
							env,
							timeoutMs: config.defaultTimeoutMs,
							maxBufferBytes: config.maxOutputBytes
						});
						lines.push(`Connectivity OK:\n${about.stdout.trim()}`);
					} catch (error) {
						lines.push(`Connectivity FAILED: ${error.message}`);
					}
				}
			}
			return { kind: "ok", text: lines.join("\n") };
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// Inventory
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_inventory",
		description: "Summarize the whole inventory: top-level folders, and counts plus up to N names per object type (datacenters, clusters, hosts, VMs, datastores, networks, resource pools).",
		params: {
			profile: PROFILE_PARAM,
			maxItems: S("integer", "Maximum names shown per type (default from plugin config).", { min: 1 })
		},
		custom: async function esxiInventory(ctx, config, store, args) {
			validateArgs(this.params, args);
			const cap = args.maxItems ?? config.inventoryMaxItems;
			const types = [
				["datacenters", "d"],
				["clusters", "c"],
				["hosts", "h"],
				["vms", "m"],
				["datastores", "s"],
				["networks", "n"],
				["resource pools", "p"]
			];
			const commands = [["ls", "/"], ...types.map(([, letter]) => ["find", "-type", letter, "-json"])];
			const results = await runGovcBatch(ctx, config, store, this, args, commands);
			const lines = [];
			const top = results[0].stdout.trim();
			lines.push(top.length > 0 ? `Top level:\n${top}` : "Top level: (empty)");
			types.forEach(([label, letter], index) => {
				let paths = [];
				try {
					const parsed = JSON.parse(results[index + 1].stdout);
					if (Array.isArray(parsed)) paths = parsed;
				} catch {
					/* keep empty */
				}
				const shown = paths.slice(0, cap).map((p) => p.replace(/^.*\//, "")).join(", ");
				const more = paths.length > cap ? ` (+${paths.length - cap} more)` : "";
				lines.push(`${label}: ${paths.length}${paths.length > 0 ? ` — ${shown}${more}` : ""}`);
			});
			return { kind: "ok", text: truncateOutput(lines.join("\n"), config.maxOutputChars) };
		}
	},
	{
		name: "esxi_find",
		description: "Search the inventory for objects by type and optional name pattern (govc find). Types: datacenter, cluster, host, vm, datastore, network, resourcepool, portgroup, folder, app, dvs, opaque, compute, all.",
		params: {
			profile: PROFILE_PARAM,
			path: S("string", "Inventory root to search under (default '/')."),
			type: S("string", "Object type to find.", { enum: ["datacenter", "cluster", "host", "vm", "datastore", "network", "resourcepool", "portgroup", "folder", "app", "dvs", "opaque", "compute", "all"] }),
			name: S("string", "Regex pattern to match against the object name (optional).")
		},
		build(args) {
			const letters = {
				datacenter: "d",
				cluster: "c",
				host: "h",
				vm: "m",
				datastore: "s",
				network: "n",
				resourcepool: "p",
				portgroup: "g",
				folder: "f",
				app: "v",
				dvs: "w",
				opaque: "o",
				compute: "r"
			};
			const argv = ["find"];
			if (args.type !== undefined && args.type !== "all") argv.push("-type", letters[args.type]);
			if (args.name !== undefined) argv.push("-name", args.name);
			argv.push(args.path ?? "/");
			return { argv };
		}
	},
	{
		name: "esxi_collect",
		description: "Collect managed-object properties (govc collect). Query arbitrary properties: esxi_collect {object: '/dc1/vm/MyVM', property: 'runtime.powerState'}. With type set, collects the property for every object of that type under the root.",
		params: {
			profile: PROFILE_PARAM,
			object: S("string", "Inventory path or MoID to read from (default '/')."),
			property: S("string", "Property path to collect, e.g. runtime.powerState or name."),
			type: S("string", "Collect from a container view of this type instead of a single object (aliases: m=vm, h=host, s=datastore, c=cluster, n=network, d=datacenter)."),
			single: S("boolean", "Print only the property value (govc collect -s)."),
			json: S("boolean", "Output raw JSON.")
		},
		build(args) {
			const argv = ["collect"];
			if (args.json) argv.push("-json");
			if (args.single) argv.push("-s");
			if (args.type !== undefined) argv.push("-type", args.type);
			argv.push(args.object ?? "/");
			if (args.property !== undefined) argv.push(args.property);
			return { argv };
		}
	},
	{
		name: "esxi_tree",
		description: "Print the inventory as a tree with object types (govc tree). Depth is configurable.",
		params: {
			profile: PROFILE_PARAM,
			path: S("string", "Inventory root (default '/')."),
			depth: S("integer", "Maximum display depth (0 = unlimited).", { min: 0 }),
			types: S("boolean", "Annotate each entry with its object type.")
		},
		build(args) {
			const argv = ["tree"];
			if (args.types) argv.push("-p");
			if (args.depth) argv.push("-L", String(args.depth));
			argv.push(args.path ?? "/");
			return { argv };
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// VMs
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_vm_list",
		description: "List VMs. Without details, prints every VM inventory path (fast). With details, also fetches power state, CPU, memory, IP, host, and tools status (govc vm.info -json, capped).",
		params: {
			profile: PROFILE_PARAM,
			details: S("boolean", "Enrich with vm.info details (default false; capped by the info cap)."),
			cap: INFO_CAP
		},
		custom: async function esxiVmList(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const found = await runGovc(config.govcPath, ["find", "-type", "m", "-json"], {
				env,
				timeoutMs: config.defaultTimeoutMs,
				maxBufferBytes: config.maxOutputBytes
			});
			let paths = [];
			try {
				const parsed = JSON.parse(found.stdout);
				if (Array.isArray(parsed)) paths = parsed;
			} catch {
				/* not json */
			}
			if (paths.length === 0) return { kind: "ok", text: "(no VMs found)" };
			if (!args.details) return { kind: "ok", text: truncateOutput(paths.join("\n"), config.maxOutputChars) };
			const batch = paths.slice(0, args.cap ?? config.infoCap);
			const info = await runGovc(config.govcPath, ["vm.info", "-json", ...batch], {
				env,
				timeoutMs: config.defaultTimeoutMs,
				maxBufferBytes: config.maxOutputBytes
			});
			const table = formatVmInfoJson(info.stdout);
			const footer = paths.length > batch.length ? `\n(+${paths.length - batch.length} more VMs not enriched; raise the cap for more)` : "";
			return { kind: "ok", text: truncateOutput((table ?? info.stdout) + footer, config.maxOutputChars) };
		}
	},
	{
		name: "esxi_vm_info",
		description: "Full details for one or more VMs: power/connection state, CPU, memory, guest IP/hostname, tools status, host, datastores, networks (govc vm.info -json -r).",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path (comma-separate for multiple).", { required: true }),
			resource: S("boolean", "Include resource summary (usage, datastores, networks).")
		},
		build(args) {
			const argv = ["vm.info", "-json"];
			if (args.resource) argv.push("-r");
			argv.push(...splitCsv(args.vm));
			return { argv };
		},
		format(outputs) {
			return formatVmInfoJson(outputs[0]);
		}
	},
	{
		name: "esxi_vm_power",
		description: "VM power operation (govc vm.power): on, off, reset, suspend, shutdown (guest), reboot (guest), standby (guest). Shutdown/reboot need VMware Tools. Everything except power-on requires approval.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			operation: S("string", "Power operation.", { required: true, enum: ["on", "off", "reset", "suspend", "shutdown", "reboot", "standby"] }),
			force: S("boolean", "Force: hard power-off / hard reboot when guest shutdown is not possible."),
			wait: S("boolean", "Wait for the operation to complete (default true).")
		},
		build(args) {
			const flags = { on: "-on", off: "-off", reset: "-reset", suspend: "-suspend", shutdown: "-s", reboot: "-r", standby: "-standby" };
			const argv = ["vm.power", flags[args.operation]];
			if (args.force) argv.push("-force");
			if (args.wait === false) argv.push("-wait=false");
			argv.push(args.vm);
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			if (!args?.operation || args.operation === "on") return undefined;
			return `Power ${args.operation.toUpperCase()} VM "${args.vm}"`;
		}
	},
	{
		name: "esxi_vm_create",
		description: "Create a new VM from scratch (govc vm.create): name, CPU, memory, disk, guest OS id, network, datastore, folder, resource pool, optional power-on. An ISO can be attached at creation time (iso/isoDatastore).",
		params: {
			profile: PROFILE_PARAM,
			name: S("string", "New VM name.", { required: true }),
			cpu: S("integer", "Number of vCPUs (default 1).", { min: 1 }),
			memory: S("integer", "Memory in MB (default 1024).", { min: 1 }),
			disk: S("string", "Disk size for a new disk, e.g. '20GB' (or a disk path to attach an existing disk)."),
			diskDatastore: S("string", "Datastore for the disk file (defaults to the VM datastore)."),
			guestId: S("string", "Guest OS identifier, e.g. otherGuest64, rhel8_64Guest, windows2019srv_64Guest (default otherGuest)."),
			network: S("string", "Network to connect the first NIC to."),
			adapter: S("string", "NIC adapter type (default e1000)."),
			datastore: S("string", "Datastore for the VM files."),
			pool: S("string", "Resource pool or cluster for placement."),
			folder: S("string", "Inventory folder."),
			powerOn: S("boolean", "Power on after creation (default true)."),
			firmware: S("string", "Firmware: bios or efi.", { enum: ["bios", "efi"] }),
			annotation: S("string", "VM annotation/description."),
			iso: S("string", "ISO path to attach to a new CD-ROM at creation, e.g. 'iso/ubuntu-24.04.4-live-server-amd64.iso' (datastore path) or 'library:/boot/linux.iso' (content library)."),
			isoDatastore: S("string", "Datastore holding the ISO (defaults to the VM datastore).")
		},
		build(args) {
			const argv = ["vm.create"];
			if (args.cpu !== undefined) argv.push("-c", String(args.cpu));
			if (args.memory !== undefined) argv.push("-m", String(args.memory));
			if (args.disk !== undefined) argv.push("-disk", args.disk);
			if (args.diskDatastore !== undefined) argv.push("-disk-datastore", args.diskDatastore);
			if (args.guestId !== undefined) argv.push("-g", args.guestId);
			if (args.network !== undefined) argv.push("-net", args.network);
			if (args.adapter !== undefined) argv.push("-net.adapter", args.adapter);
			if (args.datastore !== undefined) argv.push("-ds", args.datastore);
			if (args.pool !== undefined) argv.push("-pool", args.pool);
			if (args.folder !== undefined) argv.push("-folder", args.folder);
			if (args.powerOn === false) argv.push("-on=false");
			if (args.firmware !== undefined) argv.push("-firmware", args.firmware);
			if (args.annotation !== undefined) argv.push("-annotation", args.annotation);
			if (args.iso !== undefined) {
				argv.push("-iso", args.iso);
				if (args.isoDatastore !== undefined) argv.push("-iso-datastore", args.isoDatastore);
			}
			argv.push(args.name);
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			const parts = [];
			if (args.datastore) parts.push(`datastore ${args.datastore}`);
			if (args.pool) parts.push(`pool ${args.pool}`);
			if (args.folder) parts.push(`folder ${args.folder}`);
			return `Create VM "${args.name}"${parts.length > 0 ? ` on ${parts.join(", ")}` : ""}`;
		}
	},
	{
		name: "esxi_vm_iso",
		description: "Manage a VM's CD-ROM media (govc device.cdrom.*): add a new CD-ROM device, insert an ISO from a datastore or content library into it, or eject the current media. Without a device name, the first CD-ROM device is used (insert/eject). Insert/add also connect the device (a disconnected CD-ROM is invisible to the guest — e.g. cloud-init NoCloud seeds).",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			operation: S("string", "add creates a new CD-ROM device; insert mounts an ISO; eject removes the current media.", { required: true, enum: ["add", "insert", "eject"] }),
			device: S("string", "CD-ROM device name, e.g. cdrom-16001 (optional — insert/eject default to the first CD-ROM device)."),
			iso: S("string", "ISO to insert: datastore path like 'iso/ubuntu-24.04.4-live-server-amd64.iso' or 'library:/boot/linux.iso' (insert)."),
			datastore: S("string", "Datastore holding the ISO (insert)."),
			controller: S("string", "IDE controller name for the new device (add), e.g. ide-200."),
			connect: S("boolean", "Also connect the device after insert/add (default true — guests cannot see disconnected media).")
		},
		custom: async function esxiVmIso(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const out = [];
			const argv = [`device.cdrom.${args.operation}`, "-vm", args.vm];
			if (args.device !== undefined) argv.push("-device", args.device);
			if (args.operation === "add" && args.controller !== undefined) argv.push("-controller", args.controller);
			if (args.operation === "insert") {
				if (!args.iso) throw new Error("invalid arguments: iso is required for insert");
				if (args.datastore !== undefined) argv.push("-ds", args.datastore);
				argv.push(args.iso);
			}
			out.push((await runGovc(config.govcPath, argv, { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes })).stdout);
			if (args.operation !== "eject" && args.connect !== false) {
				const device = args.device ?? "";
				out.push((await runGovc(config.govcPath, ["device.connect", "-vm", args.vm, device], { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes })).stdout);
			}
			return { kind: "ok", text: truncateOutput(out.filter((s) => s.trim()).join("\n") || `${args.operation} done`, config.maxOutputChars) };
		},
		gate(args) {
			return `${args.operation} CD-ROM media${args.operation === "insert" ? ` (${args.iso})` : ""} on VM "${args.vm}"`;
		}
	},
	{
		name: "esxi_vm_boot",
		description: "Configure a VM's boot settings (govc device.boot): boot device order (e.g. 'cdrom,disk'), boot delay, firmware (bios/efi), and EFI secure boot. Useful for unattended-install flows: boot from an ISO once, then restore the disk order.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			order: S("string", "Boot device order, comma-separated: floppy,cdrom,ethernet,disk ('-' resets to the default order)."),
			delay: S("integer", "Delay in ms before starting the boot sequence.", { min: 0 }),
			firmware: S("string", "Firmware type.", { enum: ["bios", "efi"] }),
			secure: S("boolean", "Enable EFI secure boot (efi firmware only)."),
			retry: S("boolean", "Retry boot after the retry delay."),
			retryDelay: S("integer", "Delay in ms before a boot retry.", { min: 0 })
		},
		build(args) {
			const argv = ["device.boot", "-vm", args.vm];
			if (args.order !== undefined) argv.push("-order", args.order);
			if (args.delay !== undefined) argv.push("-delay", String(args.delay));
			if (args.firmware !== undefined) argv.push("-firmware", args.firmware);
			if (args.secure !== undefined) argv.push(`-secure=${args.secure}`);
			if (args.retry !== undefined) argv.push(`-retry=${args.retry}`);
			if (args.retryDelay !== undefined) argv.push("-retry-delay", String(args.retryDelay));
			return { argv };
		},
		gate(args) {
			return `Change boot settings for VM "${args.vm}"${args.order ? ` (order: ${args.order})` : ""}`;
		}
	},
	{
		name: "esxi_vm_serial",
		description: "Serial console for a VM (govc device.serial.* + device.connect): add a serial port, connect it to a file on the datastore ('-' = <device>.log in the VM's log dir), to a telnet listener on the host ('telnet://:33233' — needs the ESXi 'remoteSerialPort' firewall ruleset enabled; connect with `nc <host> <port>`), or disconnect it. The file form captures kernel/cloud-init console output (guests that boot with console=ttyS0); the telnet form gives an interactive login console (enable getty on that tty in the guest). Field notes: some guests stream boot output only on ttyS0 (serial port 1) — capture to file there and put the telnet console on port 2; if the first port's telnet listener stays silent, swap the backings.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			operation: S("string", "add a new serial port; connect sets its backing; disconnect removes the connection.", { required: true, enum: ["add", "connect", "disconnect"] }),
			device: S("string", "Serial port device name, e.g. serialport-9000 (connect/disconnect)."),
			uri: S("string", "Backing URI (connect): '-' for a file in the VM log dir, '[datastore] path/file.log' for a file, or 'telnet://:PORT' for an interactive host listener.")
		},
		custom: async function esxiVmSerial(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const out = [];
			if (args.operation === "add") {
				const name = (await runGovc(config.govcPath, ["device.serial.add", "-vm", args.vm], { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes })).stdout;
				out.push(name);
			} else {
				if (!args.device) throw new Error("invalid arguments: device is required for connect/disconnect (e.g. 'serialport-9000')");
				if (args.operation === "connect") {
					if (!args.uri) throw new Error("invalid arguments: uri is required for connect ('-', a datastore path, or telnet://:PORT)");
					out.push((await runGovc(config.govcPath, ["device.serial.connect", "-vm", args.vm, "-device", args.device, args.uri], { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes })).stdout);
					out.push((await runGovc(config.govcPath, ["device.connect", "-vm", args.vm, args.device], { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes })).stdout);
				} else {
					out.push((await runGovc(config.govcPath, ["device.disconnect", "-vm", args.vm, args.device], { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes })).stdout);
				}
			}
			const lines = out.filter((s) => s.trim());
			if (args.operation === "connect") lines.push(`Backing changes apply after the next power cycle. Connect a telnet listener with: nc <host> <port>`);
			return { kind: "ok", text: truncateOutput(lines.join("\n") || `${args.operation} done`, config.maxOutputChars) };
		},
		gate(args) {
			return `${args.operation} serial console on VM "${args.vm}"`;
		}
	},
	{
		name: "esxi_vmdk_convert",
		description: "Convert a VMware Workstation single-file VMDK (monolithicSparse — e.g. OpenWrt/iStoreOS appliance images) into the descriptor + raw flat layout ESXi can boot directly (monolithicFlat), uploading both files to a datastore. ESXi cannot run single-file sparse vmdks; this tool does the grain-table conversion locally (no qemu-img needed). Download the source with esxi_datastore_download first if it lives on a datastore, then pass its local path here. Afterwards attach it with esxi_vm_disk (operation: attach, link: false) or esxi_vm_create disk.",
		params: {
			profile: PROFILE_PARAM,
			source: S("string", "Local path to the monolithicSparse .vmdk file.", { required: true }),
			datastore: S("string", "Datastore to upload the converted files to.", { required: true }),
			remotePath: S("string", "Destination directory on the datastore (default: iso)."),
			name: S("string", "Base name for the output files (default: the source file name).")
		},
		custom: async function esxiVmdkConvert(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const name = args.name ?? String(args.source).split("/").pop().replace(/\.vmdk$/i, "");
			const dir = args.remotePath ?? "iso";
			const sparse = await readFile(args.source);
			const header = parseSparseHeader(sparse.subarray(0, 512));
			if (header.grainSectors !== 128) throw new Error(`unsupported grain size ${header.grainSectors} (only 128 supported)`);
			const raw = sparseVmdkToRaw(sparse);
			const descriptor = flatDescriptor({ fileName: `${name}-flat.vmdk`, capacitySectors: header.capacitySectors });
			const base = join(tmpdir(), `dsh-esxi-vmdk-${process.pid}-${Date.now().toString(36)}`);
			const flatPath = `${base}-flat.vmdk`;
			const descPath = `${base}.vmdk`;
			try {
				const fd = await open(flatPath, "w");
				try {
					const CHUNK = 64 * 1024 * 1024; // Node caps single writes at 2GiB
					for (let off = 0; off < raw.length; off += CHUNK) {
						const len = Math.min(CHUNK, raw.length - off);
						await fd.write(raw, off, len, off);
					}
				} finally {
					await fd.close();
				}
				await writeFile(descPath, descriptor);
				await runGovc(config.govcPath, ["datastore.upload", "-ds", args.datastore, descPath, `${dir}/${name}.vmdk`], { env, timeoutMs: config.longTimeoutMs, maxBufferBytes: config.maxOutputBytes });
				await runGovc(config.govcPath, ["datastore.upload", "-ds", args.datastore, flatPath, `${dir}/${name}-flat.vmdk`], { env, timeoutMs: config.longTimeoutMs, maxBufferBytes: config.maxOutputBytes });
			} finally {
				await Promise.all([rm(flatPath, { force: true }).catch(() => {}), rm(descPath, { force: true }).catch(() => {})]);
			}
			const lines = [
				`Converted ${args.source} (${header.capacitySectors} sectors, ~${Math.round(header.capacitySectors * 512 / 1024 / 1024)}MB) to:`,
				`  [${args.datastore}] ${dir}/${name}.vmdk (+ ${name}-flat.vmdk)`,
				`Next: create a VM and attach it:`,
				`  esxi_vm_disk { vm: "<vm>", operation: "attach", datastore: "${args.datastore}", name: "${dir}/${name}.vmdk", link: false }`,
				`Note: -link=false attaches the disk directly; the default link mode creates a delta disk and may fail for converted flats.`
			];
			return { kind: "ok", text: truncateOutput(lines.join("\n"), config.maxOutputChars) };
		},
		gate(args) {
			return `Convert VMDK "${args.source}" and upload to datastore "${args.datastore}"`;
		}
	},
	{
		name: "esxi_seed_iso",
		description: "Build and upload a cloud-init 'cidata' seed ISO. Two modes: 'autoinstall' creates a subiquity autoinstall user-data for the Ubuntu server ISO (NOTE: 24.04+ subiquity only enters autoinstall mode when the kernel is booted with the 'autoinstall' argument — pair this seed with a GRUB-modified ISO); 'cloudconfig' creates plain #cloud-config user-data for cloud images. The password is stored only as a SHA-512 crypt hash.",
		params: {
			profile: PROFILE_PARAM,
			name: S("string", "Seed ISO file name (e.g. 'ubuntu-2404-seed').", { required: true }),
			mode: S("string", "Seed format: autoinstall (subiquity, Ubuntu server ISO) or cloudconfig (cloud-init cloud images).", { enum: ["autoinstall", "cloudconfig"] }),
			hostname: S("string", "Target machine hostname.", { required: true }),
			username: S("string", "Initial user name.", { required: true }),
			password: S("string", "Initial user password (only its SHA-512 crypt hash is written to the seed).", { required: true }),
			datastore: S("string", "Datastore to upload the seed ISO to.", { required: true }),
			remotePath: S("string", "Destination path on the datastore (default: iso/<name>.iso)."),
			packages: S("string", "Extra packages for the installer to add, comma-separated (e.g. 'open-vm-tools,curl')."),
			sshPasswordAuth: S("boolean", "Allow SSH password authentication after install (default true)."),
			timezone: S("string", "Target timezone (default UTC).")
		},
		custom: async function esxiSeedIso(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const packages = splitCsv(args.packages);
			const mode = args.mode ?? "autoinstall";
			let userData;
			if (mode === "cloudconfig") {
				userData = [
					"#cloud-config",
					`hostname: ${args.hostname}`,
					"manage_etc_hosts: true",
					`timezone: ${args.timezone ?? "UTC"}`,
					"users:",
					`  - name: ${args.username}`,
					"    sudo: ALL=(ALL) NOPASSWD:ALL",
					"    lock_passwd: false",
					"    shell: /bin/bash",
					`    hashed_passwd: '${sha512crypt(args.password, genSalt())}'`,
					"ssh_pwauth: true"
				].join("\n");
			} else {
				userData = autoinstallUserData({
					hostname: args.hostname,
					username: args.username,
					password: args.password,
					sshPasswordAuth: args.sshPasswordAuth !== false,
					packages,
					timezone: args.timezone ?? "UTC"
				});
			}
			const metaData = autoinstallMetaData(args.hostname);
			const iso = buildSeedIso({ "user-data": userData, "meta-data": metaData });
			const localPath = join(tmpdir(), `dsh-esxi-seed-${process.pid}-${Date.now().toString(36)}.iso`);
			const remotePath = args.remotePath ?? `iso/${args.name}.iso`;
			try {
				await writeFile(localPath, iso);
				await runGovc(config.govcPath, ["datastore.upload", "-ds", args.datastore, localPath, remotePath], {
					env,
					timeoutMs: config.longTimeoutMs,
					maxBufferBytes: config.maxOutputBytes
				});
			} finally {
				await rm(localPath, { force: true }).catch(() => {});
			}
			const lines = [
				`Seed ISO uploaded: [${args.datastore}] ${remotePath}`,
				`Seed mode: ${mode}; hostname=${args.hostname}, username=${args.username}, ssh password auth=${args.sshPasswordAuth !== false ? "on" : "off"}, extra packages=${packages.join(",") || "(none)"}.`,
				mode === "autoinstall"
					? `Next: esxi_vm_iso insert this seed as a second CD-ROM, boot the server ISO with the kernel 'autoinstall' argument (GRUB-modified ISO or esxi_vm_boot + custom boot config) — subiquity then runs unattended.`
					: `Next (cloud image): esxi_vm_iso insert this seed into the VM's CD-ROM BEFORE first power-on; cloud-init's NoCloud datasource applies it. Prefer esxi_vm_cloudinit (guestinfo) for vSphere-native seeding.`,
				`Note: only the SHA-512 crypt hash of the password is stored in the seed; delete the seed ISO after use (esxi_datastore_delete).`
			];
			return { kind: "ok", text: truncateOutput(lines.join("\n"), config.maxOutputChars) };
		},
		gate(args) {
			return `Upload autoinstall seed ISO "${args.name}" to datastore "${args.datastore}"`;
		}
	},
	{
		name: "esxi_vm_clone",
		description: "Clone a VM or template (govc vm.clone): full or linked clone, from an optional snapshot, optionally as a template, optionally powered on. The datastore defaults to the source VM's datastore. Note: standalone hosts without the CloneVM license right reject cloning — the error is translated for you.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "Source VM or template name/path.", { required: true }),
			name: S("string", "New VM name.", { required: true }),
			snapshot: S("string", "Snapshot name to clone from."),
			template: S("boolean", "Create a template instead of a VM."),
			powerOn: S("boolean", "Power on the clone (default true)."),
			linked: S("boolean", "Create a linked clone (needs a snapshot)."),
			datastore: S("string", "Target datastore (defaults to the source VM's datastore)."),
			pool: S("string", "Target resource pool."),
			folder: S("string", "Target inventory folder."),
			host: S("string", "Target host."),
			cpu: S("integer", "Override vCPU count.", { min: 1 }),
			memory: S("integer", "Override memory in MB.", { min: 1 })
		},
		custom: async function esxiVmClone(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			let datastore = args.datastore;
			if (datastore === undefined) datastore = await vmDatastore(config, env, args.vm);
			const argv = ["vm.clone", "-vm", args.vm];
			if (args.snapshot !== undefined) argv.push("-snapshot", args.snapshot);
			if (args.template) argv.push("-template");
			if (args.powerOn === false) argv.push("-on=false");
			if (args.linked) argv.push("-link");
			if (datastore !== undefined) argv.push("-ds", datastore);
			if (args.pool !== undefined) argv.push("-pool", args.pool);
			if (args.folder !== undefined) argv.push("-folder", args.folder);
			if (args.host !== undefined) argv.push("-host", args.host);
			if (args.cpu !== undefined) argv.push("-c", String(args.cpu));
			if (args.memory !== undefined) argv.push("-m", String(args.memory));
			argv.push(args.name);
			try {
				const out = await runGovc(config.govcPath, argv, { env, timeoutMs: 600000, maxBufferBytes: config.maxOutputBytes });
				return { kind: "ok", text: truncateOutput(out.stdout.trim() || `Cloned "${args.name}" from "${args.vm}".`, config.maxOutputChars) };
			} catch (error) {
				if (/not supported on the object/i.test(error.message ?? "")) {
					throw new Error(`clone failed: this host's license does not permit CloneVM_Task (typical on standalone ESXi without the clone right). Use esxi_vm_export + esxi_vm_import or re-create the VM instead. Original error: ${error.message}`);
				}
				throw error;
			}
		},
		gate(args) {
			return `Clone ${args.template ? "to template" : "VM"} "${args.name}" from "${args.vm}"`;
		}
	},
	{
		name: "esxi_vm_change",
		description: "Reconfigure an existing VM (govc vm.change): rename, CPU, memory, CPU/memory reservations/limits/shares, extra config key=value pairs, annotation, latency, nested virtualization, hot-add flags, guest OS id, and more.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			name: S("string", "New display name (rename)."),
			cpu: S("integer", "New vCPU count.", { min: 1 }),
			memory: S("integer", "New memory in MB.", { min: 1 }),
			cpuLimit: S("integer", "CPU limit in MHz.", { min: 0 }),
			cpuReservation: S("integer", "CPU reservation in MHz.", { min: 0 }),
			cpuShares: S("string", "CPU shares level or number."),
			memLimit: S("integer", "Memory limit in MB.", { min: 0 }),
			memReservation: S("integer", "Memory reservation in MB.", { min: 0 }),
			memShares: S("string", "Memory shares level or number."),
			extraConfig: S("array", "ExtraConfig key=value entries, e.g. ['guestinfo.foo=bar'].", { items: "string" }),
			annotation: S("string", "New annotation text."),
			guestId: S("string", "Guest OS identifier."),
			latency: S("string", "Latency sensitivity.", { enum: ["low", "normal", "medium", "high", "custom"] }),
			nestedHv: S("boolean", "Enable nested hardware-assisted virtualization."),
			cpuHotAdd: S("boolean", "Enable CPU hot add."),
			memoryHotAdd: S("boolean", "Enable memory hot add."),
			syncTimeWithHost: S("boolean", "Enable sync time with host.")
		},
		build(args) {
			const argv = ["vm.change", "-vm", args.vm];
			if (args.name !== undefined) argv.push("-name", args.name);
			if (args.cpu !== undefined) argv.push("-c", String(args.cpu));
			if (args.memory !== undefined) argv.push("-m", String(args.memory));
			if (args.cpuLimit !== undefined) argv.push("-cpu.limit", String(args.cpuLimit));
			if (args.cpuReservation !== undefined) argv.push("-cpu.reservation", String(args.cpuReservation));
			if (args.cpuShares !== undefined) argv.push("-cpu.shares", args.cpuShares);
			if (args.memLimit !== undefined) argv.push("-mem.limit", String(args.memLimit));
			if (args.memReservation !== undefined) argv.push("-mem.reservation", String(args.memReservation));
			if (args.memShares !== undefined) argv.push("-mem.shares", args.memShares);
			if (args.guestId !== undefined) argv.push("-g", args.guestId);
			if (args.annotation !== undefined) argv.push("-annotation", args.annotation);
			if (args.latency !== undefined) argv.push("-latency", args.latency);
			if (args.nestedHv !== undefined) argv.push(`-nested-hv-enabled=${args.nestedHv}`);
			if (args.cpuHotAdd !== undefined) argv.push(`-cpu-hot-add-enabled=${args.cpuHotAdd}`);
			if (args.memoryHotAdd !== undefined) argv.push(`-memory-hot-add-enabled=${args.memoryHotAdd}`);
			if (args.syncTimeWithHost !== undefined) argv.push(`-sync-time-with-host=${args.syncTimeWithHost}`);
			for (const entry of args.extraConfig ?? []) argv.push("-e", entry);
			return { argv };
		},
		gate(args) {
			return `Reconfigure VM "${args.vm}"${args.name ? ` (rename to "${args.name}")` : ""}`;
		}
	},
	{
		name: "esxi_vm_import",
		description: "Import an OVA/OVF template (e.g. an official Ubuntu cloud-image .ova) as a new VM (govc import.ova / import.ovf). This is the first step of the one-click provisioning flow used by cloud/VPS providers: import the image, inject cloud-init user-data with esxi_vm_cloudinit BEFORE first power-on, grow the disk with esxi_vm_disk resize, then esxi_vm_power on — the OS configures itself with zero interaction.",
		params: {
			profile: PROFILE_PARAM,
			file: S("string", "OVA/OVF source: local file path, http(s) URL, or datastore path. An .ova is the tar archive; an .ovf is the descriptor (sibling files are fetched).", { required: true }),
			name: S("string", "New VM name (defaults to the template name)."),
			datastore: S("string", "Target datastore."),
			folder: S("string", "Target inventory folder."),
			pool: S("string", "Target resource pool (vCenter)."),
			options: S("string", "Local path to an import.spec JSON (network mapping, etc.; generate with esxi_run 'import.spec <file.ova>').")
		},
		build(args) {
			const isOvf = /\.ovf(\?|#|$)/i.test(args.file);
			const argv = [isOvf ? "import.ovf" : "import.ova"];
			if (args.name !== undefined) argv.push("-name", args.name);
			if (args.datastore !== undefined) argv.push("-ds", args.datastore);
			if (args.folder !== undefined) argv.push("-folder", args.folder);
			if (args.pool !== undefined) argv.push("-pool", args.pool);
			if (args.options !== undefined) argv.push("-options", args.options);
			argv.push(args.file);
			return { argv, timeoutMs: 900000 };
		},
		gate(args) {
			return `Import ${args.file} as VM "${args.name ?? "(template name)"}"`;
		}
	},
	{
		name: "esxi_vm_cloudinit",
		description: "Inject cloud-init user-data / meta-data into a VM through VMware guestinfo (the vmware-guestinfo datasource). This is the one-click provisioning mechanism cloud and VPS providers use: configure the seed BEFORE first power-on and the OS provisions itself on first boot — hostname, users, passwords/SSH keys, disk grow — with no interactive screens. Needs VMware Tools in the guest (official cloud images ship open-vm-tools). Pair with esxi_vm_import + esxi_vm_disk resize + esxi_vm_power. Field notes: on cloud-init 26.x set passwords with `hashed_passwd:` inside `users:` (the legacy `passwd:` key is silently ignored, leaving the account locked — verify via /etc/shadow or login); avoid usernames that collide with pre-existing groups (Ubuntu cloud images ship an 'admin' GROUP, so useradd for 'admin' fails — use 'ubuntu' or add primary_group).",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			userData: S("string", "Cloud-config user-data: either a local file path or inline '#cloud-config' YAML text (multi-line is fine).", { required: true }),
			metaData: S("string", "Meta-data: local file path or inline YAML. Defaults to instance-id + local-hostname derived from the VM name."),
			instanceId: S("string", "instance-id override for the default meta-data, e.g. 'i-0001'."),
			clear: S("boolean", "Clear existing guestinfo.userdata/metadata instead of setting new values.")
		},
		custom: async function esxiVmCloudinit(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			if (args.clear) {
				await runGovc(config.govcPath, [
					"vm.change", "-vm", args.vm,
					"-e", "guestinfo.userdata=",
					"-e", "guestinfo.metadata=",
					"-e", "guestinfo.userdata.encoding=",
					"-e", "guestinfo.metadata.encoding="
				], { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes });
				return { kind: "ok", text: `Cleared guestinfo cloud-init keys on VM "${args.vm}".` };
			}
			const readValue = async (value, kind) => {
				if (value === undefined || value === null) return null;
				const trimmed = String(value);
				const looksInline = trimmed.includes("\n") || trimmed.startsWith("#cloud-config") || trimmed.startsWith("#!");
				if (looksInline) return trimmed;
				try {
					return await readFile(trimmed, "utf8");
				} catch {
					throw new Error(`invalid arguments: ${kind} is neither inline YAML nor a readable file: ${trimmed}`);
				}
			};
			const userData = await readValue(args.userData, "userData");
			let metaData = await readValue(args.metaData, "metaData");
			if (metaData === null) {
				const name = String(args.vm).split("/").pop();
				const instanceId = args.instanceId ?? `${name}-001`;
				metaData = `instance-id: ${instanceId}\nlocal-hostname: ${name}`;
			} else if (args.instanceId !== undefined) {
				metaData = String(metaData).replace(/^instance-id:.*$/m, `instance-id: ${args.instanceId}`);
			}
			const files = [
				{ key: "guestinfo.userdata", content: Buffer.from(userData, "utf8").toString("base64") },
				{ key: "guestinfo.metadata", content: Buffer.from(metaData, "utf8").toString("base64") }
			];
			const tmp = join(tmpdir(), `dsh-esxi-cloudinit-${process.pid}-${Date.now().toString(36)}`);
			const argv = ["vm.change", "-vm", args.vm];
			try {
				for (let i = 0; i < files.length; i++) {
					const p = `${tmp}-${i}`;
					await writeFile(p, files[i].content);
					argv.push("-f", `${files[i].key}=${p}`);
				}
				argv.push("-e", "guestinfo.userdata.encoding=base64", "-e", "guestinfo.metadata.encoding=base64");
				await runGovc(config.govcPath, argv, { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes });
			} finally {
				await Promise.all(files.map((_, i) => rm(`${tmp}-${i}`, { force: true }).catch(() => {})));
			}
			return {
				kind: "ok",
				text: truncateOutput([
					`Cloud-init seed injected into VM "${args.vm}" via guestinfo (base64 user-data + meta-data).`,
					`Power the VM on to apply it on first boot; verify with esxi_vm_info (IP/tools).`,
					`To re-seed after first boot: clear (clear:true), reset cloud-init in the guest (cloud-init clean), power off/on.`
				].join("\n"), config.maxOutputChars)
			};
		},
		gate(args) {
			return `${args.clear ? "Clear" : "Inject"} cloud-init guestinfo on VM "${args.vm}"`;
		}
	},
	{
		name: "esxi_vm_disk",
		description: "VM disk operations (govc vm.disk.* / device.remove): create a new disk, attach an existing vmdk, detach a disk keeping its files, or resize (grow) a disk.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			operation: S("string", "Disk operation.", { required: true, enum: ["create", "attach", "detach", "resize"] }),
			name: S("string", "Disk name or path: create — e.g. MyVM/disk2; attach — vmdk path e.g. MyVM/MyVM_1.vmdk; detach — device label/key e.g. disk-2000; resize — disk name.", { required: true }),
			size: S("string", "Size for create or resize, e.g. '20GB' (resize only grows)."),
			datastore: S("string", "Datastore for a new/attached disk."),
			controller: S("string", "Disk controller type for a new disk (default scsi; pvscsi recommended)."),
			thick: S("boolean", "Thick-provision a new disk."),
			eager: S("boolean", "Eagerly scrub a new disk (implies thick)."),
			mode: S("string", "Disk mode.", { enum: ["persistent", "nonpersistent", "undoable", "independent_persistent", "independent_nonpersistent", "append"] })
		},
		custom: async function esxiVmDisk(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const argv = [];
			if (args.operation === "create") {
				if (!args.size) throw new Error("invalid arguments: size is required for create (e.g. '20GB')");
				let datastore = args.datastore;
				if (datastore === undefined) datastore = await vmDatastore(config, env, args.vm);
				argv.push("vm.disk.create", "-vm", args.vm, "-name", args.name, "-size", args.size);
				if (datastore !== undefined) argv.push("-ds", datastore);
				if (args.controller !== undefined) argv.push("-controller", args.controller);
				if (args.thick) argv.push("-thick");
				if (args.eager) argv.push("-eager");
				if (args.mode !== undefined) argv.push("-mode", args.mode);
			} else if (args.operation === "attach") {
				argv.push("vm.disk.attach", "-vm", args.vm, "-disk", args.name);
				if (args.datastore !== undefined) argv.push("-ds", args.datastore);
				if (args.controller !== undefined) argv.push("-controller", args.controller);
				if (args.mode !== undefined) argv.push("-mode", args.mode);
			} else if (args.operation === "detach") {
				argv.push("device.remove", "-vm", args.vm, "-keep", args.name);
			} else {
				if (!args.size) throw new Error("invalid arguments: size is required for resize (grow only, e.g. '200GB')");
				argv.push("vm.disk.change", "-vm", args.vm, "-disk.name", args.name, "-size", args.size);
			}
			const out = await runGovc(config.govcPath, argv, { env, timeoutMs: config.defaultTimeoutMs, maxBufferBytes: config.maxOutputBytes });
			return { kind: "ok", text: truncateOutput(out.stdout.trim() || `${args.operation} done`, config.maxOutputChars) };
		},
		gate(args) {
			return `${args.operation} disk on VM "${args.vm}"`;
		}
	},
	{
		name: "esxi_vm_network",
		description: "VM network adapter operations: add a NIC to a network, change a NIC's network/adapter/MAC, or remove a NIC (govc vm.network.add / vm.network.change / device.remove).",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			operation: S("string", "Adapter operation.", { required: true, enum: ["add", "change", "remove"] }),
			network: S("string", "Network or portgroup name (e.g. 'VM Network' or 'Switch/Portgroup')."),
			device: S("string", "NIC device for change/remove, e.g. ethernet-0 (find it with esxi_vm_info or esxi_run 'device.info -vm <vm> ethernet-*')."),
			adapter: S("string", "Adapter type (default e1000; vmxnet3 recommended)."),
			mac: S("string", "MAC address to assign ('-' generates one).")
		},
		build(args) {
			const argv = [];
			if (args.operation === "remove") {
				if (!args.device) throw new Error("invalid arguments: device is required for remove (e.g. 'ethernet-0'; find it with esxi_vm_info or esxi_run 'device.info -vm <vm> ethernet-*')");
				argv.push("device.remove", "-vm", args.vm, args.device);
			} else {
				if (args.operation === "change" && !args.device) {
					throw new Error("invalid arguments: device is required for change (e.g. 'ethernet-0')");
				}
				if (args.operation === "change" && args.network === undefined) {
					throw new Error("invalid arguments: govc requires network on change even when only the MAC is updated ('-net' is required with '-net.address'); pass the NIC's current network name, e.g. 'VM Network'.");
				}
				argv.push(`vm.network.${args.operation}`, "-vm", args.vm);
				if (args.network !== undefined) argv.push("-net", args.network);
				if (args.adapter !== undefined) argv.push("-net.adapter", args.adapter);
				if (args.mac !== undefined) argv.push("-net.address", args.mac);
				if (args.operation === "change") argv.push(args.device);
			}
			return { argv };
		},
		gate(args) {
			return `${args.operation} NIC${args.network ? ` on network "${args.network}"` : ""} for VM "${args.vm}"`;
		}
	},
	{
		name: "esxi_vm_snapshot",
		description: "VM snapshots (govc snapshot.*): list the snapshot tree, create a snapshot (with or without memory, optionally quiesced), revert to a snapshot, or remove one (or all).",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			operation: S("string", "Snapshot operation.", { required: true, enum: ["list", "create", "revert", "remove"] }),
			name: S("string", "Snapshot name (create/revert/remove)."),
			description: S("string", "Snapshot description (create)."),
			memory: S("boolean", "Include memory state in the snapshot (default true)."),
			quiesce: S("boolean", "Quiesce the guest file system (needs Tools)."),
			removeChildren: S("boolean", "Also remove child snapshots (remove)."),
			removeAll: S("boolean", "Remove ALL snapshots (remove; name ignored).")
		},
		build(args) {
			const argv = [];
			if (args.operation === "list") {
				argv.push("snapshot.tree", "-vm", args.vm);
			} else if (args.operation === "create") {
				if (!args.name) throw new Error("invalid arguments: name is required for create");
				// Go's flag package stops at the first positional, so every flag
				// must precede the snapshot NAME (the only positional).
				argv.push("snapshot.create", "-vm", args.vm);
				if (args.description !== undefined) argv.push("-d", args.description);
				if (args.memory === false) argv.push("-m=false");
				if (args.quiesce) argv.push("-q");
				argv.push(args.name);
			} else if (args.operation === "revert") {
				argv.push("snapshot.revert", "-vm", args.vm);
				if (args.name !== undefined) argv.push(args.name);
			} else {
				if (!args.removeAll && !args.name) throw new Error("invalid arguments: name (or removeAll: true) is required for remove");
				argv.push("snapshot.remove", "-vm", args.vm);
				if (args.removeChildren) argv.push("-r");
				if (args.removeAll) argv.push("*");
				else if (args.name !== undefined) argv.push(args.name);
			}
			return { argv };
		},
		gate(args) {
			if (args?.operation === "revert") return `Revert VM "${args.vm}" to snapshot "${args.name ?? "(current)"}"`;
			if (args?.operation === "remove") return `Remove snapshot${args?.removeAll ? "s (ALL)" : ` "${args?.name}"`} from VM "${args.vm}"`;
			return undefined;
		}
	},
	{
		name: "esxi_vm_migrate",
		description: "Migrate a VM (govc vm.migrate): vMotion to another host, to another resource pool, and/or Storage vMotion to another datastore.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			host: S("string", "Destination host."),
			pool: S("string", "Destination resource pool."),
			datastore: S("string", "Destination datastore (Storage vMotion)."),
			priority: S("string", "Task priority.", { enum: ["low", "defaultPriority", "high"] })
		},
		build(args) {
			if (!args.host && !args.pool && !args.datastore) {
				throw new Error("invalid arguments: at least one of host, pool, or datastore is required for migrate");
			}
			const argv = ["vm.migrate"];
			if (args.host !== undefined) argv.push("-host", args.host);
			if (args.pool !== undefined) argv.push("-pool", args.pool);
			if (args.datastore !== undefined) argv.push("-ds", args.datastore);
			if (args.priority !== undefined) argv.push("-priority", args.priority);
			argv.push(args.vm);
			return { argv, timeoutMs: 600000 };
		},
		gate(args) {
			const targets = [args.host && `host "${args.host}"`, args.pool && `pool "${args.pool}"`, args.datastore && `datastore "${args.datastore}"`].filter(Boolean).join(", ");
			return `Migrate VM "${args.vm}" to ${targets || "(no destination given)"}`;
		}
	},
	{
		name: "esxi_vm_export",
		description: "Export a VM as OVF (govc export.ovf) into a local directory. Optionally bundle the directory into an OVA (needs the tar binary). Long-running; the default timeout is 10 minutes.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			destination: S("string", "Local directory to write the OVF files into.", { required: true }),
			ova: S("boolean", "Also bundle the exported files into <destination>.ova (needs the tar binary)."),
			includeImages: S("boolean", "Include image files (iso/img)."),
			snapshot: S("string", "Export from this snapshot instead of the current disk state."),
			force: S("boolean", "Overwrite existing files in the destination.")
		},
		custom: async function esxiVmExport(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const argv = ["export.ovf", "-vm", args.vm];
			if (args.includeImages) argv.push("-i");
			if (args.snapshot !== undefined) argv.push("-snapshot", args.snapshot);
			if (args.force) argv.push("-f");
			argv.push(args.destination);
			const result = await runGovc(config.govcPath, argv, {
				env,
				timeoutMs: config.longTimeoutMs,
				maxBufferBytes: config.maxOutputBytes
			});
			let text = result.stdout.trim() || `Exported "${args.vm}" to ${args.destination}`;
			if (args.ova) {
				const base = args.destination.replace(/[\\/]+$/, "");
				const ovaPath = `${base}.ova`;
				await runLocal(["tar", "-cf", ovaPath, "-C", args.destination, "."], { timeoutMs: config.longTimeoutMs });
				text += `\nBundled OVA: ${ovaPath}`;
			}
			return { kind: "ok", text: truncateOutput(text, config.maxOutputChars) };
		}
	},
	{
		name: "esxi_vm_template",
		description: "Convert a powered-off VM to a template or a template back to a VM (govc vm.markastemplate / vm.markasvm).",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM or template name/path.", { required: true }),
			operation: S("string", "markAsTemplate converts a VM to a template; markAsVm converts a template back.", { required: true, enum: ["markAsTemplate", "markAsVm"] }),
			host: S("string", "Host for the converted VM (markAsVm)."),
			pool: S("string", "Resource pool for the converted VM (markAsVm).")
		},
		build(args) {
			if (args.operation === "markAsTemplate") return { argv: ["vm.markastemplate", args.vm] };
			const argv = ["vm.markasvm"];
			if (args.host !== undefined) argv.push("-host", args.host);
			if (args.pool !== undefined) argv.push("-pool", args.pool);
			argv.push(args.vm);
			return { argv };
		},
		gate(args) {
			return `${args.operation} on "${args.vm}"`;
		}
	},
	{
		name: "esxi_vm_register",
		description: "Register an existing VM (from its .vmx on a datastore) into the inventory (govc vm.register).",
		params: {
			profile: PROFILE_PARAM,
			datastore: S("string", "Datastore holding the VM files.", { required: true }),
			path: S("string", "Path to the .vmx relative to the datastore root, e.g. MyVM/MyVM.vmx.", { required: true }),
			name: S("string", "Name to register the VM under (defaults to the .vmx name)."),
			pool: S("string", "Resource pool."),
			host: S("string", "Host."),
			folder: S("string", "Inventory folder."),
			template: S("boolean", "Register as a template.")
		},
		build(args) {
			const argv = ["vm.register", "-ds", args.datastore];
			if (args.name !== undefined) argv.push("-name", args.name);
			if (args.pool !== undefined) argv.push("-pool", args.pool);
			if (args.host !== undefined) argv.push("-host", args.host);
			if (args.folder !== undefined) argv.push("-folder", args.folder);
			if (args.template) argv.push("-template");
			argv.push(args.path);
			return { argv };
		},
		gate(args) {
			return `Register VM "${args.path}" on datastore "${args.datastore}"`;
		}
	},
	{
		name: "esxi_vm_unregister",
		description: "Remove a VM from the inventory WITHOUT deleting its files (govc vm.unregister).",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true })
		},
		build(args) {
			return { argv: ["vm.unregister", args.vm] };
		},
		gate(args) {
			return `Unregister VM "${args.vm}" (files stay on disk)`;
		}
	},
	{
		name: "esxi_vm_delete",
		description: "Permanently delete a VM: powers it off and removes its files from the datastore (govc vm.destroy). Cannot be undone. Requires approval.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true })
		},
		build(args) {
			return { argv: ["vm.destroy", args.vm], timeoutMs: 300000 };
		},
		gate(args) {
			return `PERMANENTLY delete VM "${args.vm}" and its files`;
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// Guest operations (need VMware Tools + guest credentials)
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_guest_exec",
		description: "Run a program inside the guest OS (govc guest.start), list guest processes (guest.ps), or kill a process (guest.kill). Requires VMware Tools and guest credentials.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			operation: S("string", "start runs a command; ps lists processes; kill terminates by PID.", { required: true, enum: ["start", "ps", "kill"] }),
			username: S("string", "Guest account (e.g. root or Administrator).", { required: true }),
			password: S("string", "Guest account password.", { required: true }),
			command: S("string", "Command line to run inside the guest (start), e.g. /bin/echo hello."),
			pid: S("integer", "Process ID (kill).", { min: 1 })
		},
		build(args) {
			const argv = [`guest.${args.operation}`, "-vm", args.vm, "-l", `${args.username}:${args.password}`];
			if (args.operation === "start") {
				if (!args.command) throw new Error("invalid arguments: command is required for start");
				argv.push(...splitArgs(args.command));
			}
			if (args.operation === "kill") {
				if (!args.pid) throw new Error("invalid arguments: pid is required for kill");
				argv.push("-p", String(args.pid));
			}
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			if (args?.operation === "start") return `Run "${args.command}" in the guest of VM "${args.vm}"`;
			if (args?.operation === "kill") return `Kill PID ${args.pid} inside VM "${args.vm}"`;
			return undefined;
		}
	},
	{
		name: "esxi_guest_file",
		description: "File operations inside the guest OS (govc guest.upload / guest.download / guest.ls / guest.mkdir / guest.rm). Requires VMware Tools and guest credentials.",
		params: {
			profile: PROFILE_PARAM,
			vm: S("string", "VM name or inventory path.", { required: true }),
			operation: S("string", "File operation.", { required: true, enum: ["upload", "download", "list", "mkdir", "rm"] }),
			username: S("string", "Guest account.", { required: true }),
			password: S("string", "Guest account password.", { required: true }),
			localPath: S("string", "Local file path (upload source / download destination)."),
			remotePath: S("string", "Guest file path (upload destination / download source / ls / mkdir / rm target)."),
			overwrite: S("boolean", "Overwrite an existing destination file."),
			parents: S("boolean", "Create intermediate directories (mkdir).")
		},
		build(args) {
			const argv = [`guest.${args.operation}`, "-vm", args.vm, "-l", `${args.username}:${args.password}`];
			if (args.overwrite) argv.push("-f");
			if (args.operation === "mkdir" && args.parents) argv.push("-p");
			if (args.operation === "upload") argv.push(args.localPath, args.remotePath);
			else if (args.operation === "download") argv.push(args.remotePath, args.localPath);
			else argv.push(args.remotePath);
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			if (args?.operation === "rm") return `Remove guest file "${args.remotePath}" in VM "${args.vm}"`;
			if (args?.operation === "upload") return `Upload ${args.localPath} to guest path "${args.remotePath}" in VM "${args.vm}"`;
			return undefined;
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// Datastores
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_datastore_list",
		description: "List datastores with type, capacity, free space, and utilization (govc datastore.info).",
		params: {
			profile: PROFILE_PARAM,
			datastore: S("string", "Optional datastore name to show just one.")
		},
		build(args) {
			const argv = ["datastore.info", "-json"];
			if (args.datastore !== undefined) argv.push(args.datastore);
			return { argv };
		},
		format(outputs) {
			return formatDatastoreInfoJson(outputs[0]);
		}
	},
	{
		name: "esxi_datastore_browse",
		description: "Browse files on a datastore (govc datastore.ls) with long listing and optional recursion.",
		params: {
			profile: PROFILE_PARAM,
			datastore: S("string", "Datastore name.", { required: true }),
			path: S("string", "Remote path (default '/')."),
			long: S("boolean", "Long listing with sizes and dates (default true)."),
			recursive: S("boolean", "Recurse into subdirectories.")
		},
		build(args) {
			const argv = ["datastore.ls", "-ds", args.datastore];
			if (args.long !== false) argv.push("-l");
			if (args.recursive) argv.push("-R");
			argv.push(args.path ?? "/");
			return { argv };
		}
	},
	{
		name: "esxi_datastore_upload",
		description: "Upload a local file to a datastore (govc datastore.upload). Long-running; default timeout 10 minutes.",
		params: {
			profile: PROFILE_PARAM,
			datastore: S("string", "Target datastore.", { required: true }),
			localPath: S("string", "Local file to upload.", { required: true }),
			remotePath: S("string", "Destination path on the datastore, e.g. MyVM/config.iso.", { required: true })
		},
		build(args) {
			return { argv: ["datastore.upload", "-ds", args.datastore, args.localPath, args.remotePath], timeoutMs: 600000 };
		},
		gate(args) {
			return `Upload ${args.localPath} → datastore "${args.datastore}" path ${args.remotePath}`;
		}
	},
	{
		name: "esxi_datastore_download",
		description: "Download a file from a datastore to the local system (govc datastore.download). Long-running; default timeout 10 minutes.",
		params: {
			profile: PROFILE_PARAM,
			datastore: S("string", "Source datastore.", { required: true }),
			remotePath: S("string", "Remote file path, e.g. MyVM/MyVM.vmdk.", { required: true }),
			localPath: S("string", "Local destination file.", { required: true })
		},
		build(args) {
			return { argv: ["datastore.download", "-ds", args.datastore, args.remotePath, args.localPath], timeoutMs: 600000 };
		}
	},
	{
		name: "esxi_datastore_copy",
		description: "Copy or move files within or between datastores (govc datastore.cp / datastore.mv).",
		params: {
			profile: PROFILE_PARAM,
			source: S("string", "Source path (optionally with [datastore] prefix).", { required: true }),
			destination: S("string", "Destination path.", { required: true }),
			datastore: S("string", "Datastore when both paths are relative to one store."),
			move: S("boolean", "Move instead of copy (datastore.mv)."),
			overwrite: S("boolean", "Overwrite an identically named destination.")
		},
		build(args) {
			const argv = [args.move ? "datastore.mv" : "datastore.cp"];
			if (args.datastore !== undefined) argv.push("-ds", args.datastore);
			if (args.overwrite) argv.push("-f");
			argv.push(args.source, args.destination);
			return { argv, timeoutMs: 600000 };
		},
		gate(args) {
			return `${args.move ? "Move" : "Copy"} datastore file ${args.source} → ${args.destination}`;
		}
	},
	{
		name: "esxi_datastore_delete",
		description: "Delete a file or directory tree from a datastore (govc datastore.rm). Cannot be undone. Requires approval.",
		params: {
			profile: PROFILE_PARAM,
			datastore: S("string", "Datastore.", { required: true }),
			path: S("string", "Remote path to delete, e.g. MyVM or images/base.vmdk.", { required: true }),
			force: S("boolean", "Ignore nonexistent files (datastore.rm -f).")
		},
		build(args) {
			const argv = ["datastore.rm", "-ds", args.datastore];
			if (args.force) argv.push("-f");
			argv.push(args.path);
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			return `DELETE datastore path "${args.path}" on "${args.datastore}"`;
		}
	},
	{
		name: "esxi_datastore_create",
		description: "Create a datastore: mkdir a folder on an existing datastore, or create an NFS/VMFS/local datastore on hosts (govc datastore.mkdir / datastore.create).",
		params: {
			profile: PROFILE_PARAM,
			operation: S("string", "mkdir creates a folder; nfs/vmfs/local create a new datastore on the given hosts.", { required: true, enum: ["mkdir", "nfs", "vmfs", "local"] }),
			datastore: S("string", "Datastore (mkdir)."),
			path: S("string", "Remote folder path (mkdir)."),
			hosts: S("string", "Hosts or cluster to create the datastore on, comma-separated (nfs/vmfs/local)."),
			name: S("string", "New datastore name (nfs/vmfs/local)."),
			remoteHost: S("string", "NFS server hostname (nfs)."),
			remotePath: S("string", "NFS export path (nfs)."),
			accessMode: S("string", "NFS access mode (readOnly|readWrite).", { enum: ["readOnly", "readWrite"] }),
			disk: S("string", "Canonical disk name, e.g. mpx.vmhba0:C0:T0:L0 (vmfs)."),
			size: S("string", "VMFS size, e.g. 20G (defaults to the whole disk).")
		},
		build(args) {
			const argv = [];
			if (args.operation === "mkdir") {
				if (!args.datastore || !args.path) throw new Error("invalid arguments: datastore and path are required for mkdir");
				argv.push("datastore.mkdir", "-ds", args.datastore, args.path);
			} else {
				const hosts = splitCsv(args.hosts);
				if (hosts.length === 0) throw new Error(`invalid arguments: hosts is required for ${args.operation}`);
				if (!args.name) throw new Error("invalid arguments: name is required");
				argv.push("datastore.create", "-type", args.operation, "-name", args.name);
				if (args.operation === "nfs") {
					if (!args.remoteHost || !args.remotePath) throw new Error("invalid arguments: remoteHost and remotePath are required for nfs");
					argv.push("-remote-host", args.remoteHost, "-remote-path", args.remotePath);
					if (args.accessMode !== undefined) argv.push("-mode", args.accessMode);
				}
				if (args.operation === "vmfs") {
					if (!args.disk) throw new Error("invalid arguments: disk is required for vmfs");
					argv.push("-disk", args.disk);
					if (args.size !== undefined) argv.push("-size", args.size);
				}
				if (args.operation === "local") {
					if (!args.path) throw new Error("invalid arguments: path is required for local");
					argv.push("-path", args.path);
				}
				argv.push(...hosts);
			}
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			if (args?.operation === "mkdir") return `Create datastore folder "${args.path}" on "${args.datastore}"`;
			return `Create ${args.operation.toUpperCase()} datastore "${args.name}" on ${args.hosts}`;
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// Networking
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_network_list",
		description: "List networks and portgroups (govc find for Network); with a host, lists that host's standard portgroups (host.portgroup.info).",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host to show its standard portgroups for (optional).")
		},
		build(args) {
			if (args.host !== undefined) return { argv: ["host.portgroup.info", "-host", args.host] };
			// govc find -type accepts a single type; the old 'n,g' comma form is invalid.
			return { argv: ["find", "-type", "n", "-json"] };
		},
		format(outputs) {
			try {
				const paths = JSON.parse(outputs[0]);
				if (Array.isArray(paths)) return paths.length > 0 ? paths.join("\n") : "(no networks found)";
			} catch {
				/* raw text */
			}
			return undefined;
		}
	},
	{
		name: "esxi_portgroup_add",
		description: "Add a portgroup: a standard portgroup on a host vSwitch (host.portgroup.add) or a distributed portgroup on a distributed switch (dvs.portgroup.add).",
		params: {
			profile: PROFILE_PARAM,
			name: S("string", "Portgroup name.", { required: true }),
			mode: S("string", "standard adds to a host vSwitch; distributed adds to a distributed switch.", { required: true, enum: ["standard", "distributed"] }),
			host: S("string", "Host (standard mode)."),
			vswitch: S("string", "vSwitch name (standard mode, default vSwitch0)."),
			vlan: S("integer", "VLAN ID.", { min: 0, max: 4094 }),
			distributedSwitch: S("string", "Distributed switch path/name (distributed mode)."),
			binding: S("string", "Port binding (distributed mode): earlyBinding (static), lateBinding (dynamic), ephemeral (no binding).", { enum: ["earlyBinding", "lateBinding", "ephemeral"] }),
			ports: S("integer", "Number of ports (distributed mode, default 128).", { min: 1 })
		},
		build(args) {
			const argv = [];
			if (args.mode === "standard") {
				argv.push("host.portgroup.add");
				if (args.host !== undefined) argv.push("-host", args.host);
				if (args.vswitch !== undefined) argv.push("-vswitch", args.vswitch);
				if (args.vlan !== undefined) argv.push("-vlan", String(args.vlan));
				argv.push(args.name);
			} else {
				if (!args.distributedSwitch) throw new Error("invalid arguments: distributedSwitch is required in distributed mode");
				argv.push("dvs.portgroup.add", "-dvs", args.distributedSwitch);
				if (args.vlan !== undefined) argv.push("-vlan", String(args.vlan));
				if (args.binding !== undefined) argv.push("-type", args.binding);
				if (args.ports !== undefined) argv.push("-nports", String(args.ports));
				argv.push(args.name);
			}
			return { argv };
		},
		gate(args) {
			return `Add ${args.mode} portgroup "${args.name}"${args.vlan !== undefined ? ` (VLAN ${args.vlan})` : ""}`;
		}
	},
	{
		name: "esxi_portgroup_remove",
		description: "Remove a standard portgroup from a host vSwitch (host.portgroup.remove) or a distributed portgroup (object.destroy on its inventory path).",
		params: {
			profile: PROFILE_PARAM,
			name: S("string", "Portgroup name.", { required: true }),
			mode: S("string", "standard or distributed.", { required: true, enum: ["standard", "distributed"] }),
			host: S("string", "Host (standard mode)."),
			vswitch: S("string", "vSwitch name (standard mode, default vSwitch0)."),
			distributedSwitch: S("string", "Distributed switch path (distributed mode; the portgroup inventory path is <switch path>/<name>).")
		},
		build(args) {
			if (args.mode === "standard") {
				const argv = ["host.portgroup.remove"];
				if (args.host !== undefined) argv.push("-host", args.host);
				if (args.vswitch !== undefined) argv.push("-vswitch", args.vswitch);
				argv.push(args.name);
				return { argv };
			}
			if (!args.distributedSwitch) throw new Error("invalid arguments: distributedSwitch is required in distributed mode");
			return { argv: ["object.destroy", `${args.distributedSwitch}/${args.name}`] };
		},
		gate(args) {
			return `Remove ${args.mode} portgroup "${args.name}"`;
		}
	},
	{
		name: "esxi_vswitch_list",
		description: "List the standard vSwitches of a host (govc host.vswitch.info).",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host name or inventory path.", { required: true })
		},
		build(args) {
			return { argv: ["host.vswitch.info", "-host", args.host] };
		}
	},
	{
		name: "esxi_vswitch_add",
		description: "Create a standard vSwitch on a host (govc host.vswitch.add).",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true }),
			name: S("string", "vSwitch name (e.g. vSwitch2).", { required: true }),
			nic: S("string", "Physical NIC to bridge (e.g. vmnic2)."),
			mtu: S("integer", "MTU.", { min: 576, max: 9000 }),
			ports: S("integer", "Number of ports (default 128).", { min: 1 })
		},
		build(args) {
			const argv = ["host.vswitch.add", "-host", args.host];
			if (args.nic !== undefined) argv.push("-nic", args.nic);
			if (args.mtu !== undefined) argv.push("-mtu", String(args.mtu));
			if (args.ports !== undefined) argv.push("-ports", String(args.ports));
			argv.push(args.name);
			return { argv };
		},
		gate(args) {
			return `Add vSwitch "${args.name}" to host "${args.host}"`;
		}
	},
	{
		name: "esxi_vswitch_remove",
		description: "Remove a standard vSwitch from a host (govc host.vswitch.remove).",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true }),
			name: S("string", "vSwitch name.", { required: true })
		},
		build(args) {
			return { argv: ["host.vswitch.remove", "-host", args.host, args.name] };
		},
		gate(args) {
			return `Remove vSwitch "${args.name}" from host "${args.host}"`;
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// Hosts
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_host_list",
		description: "List hosts: connection state, power, maintenance mode, product/version/build, CPU model, cores, memory, CPU usage (govc host.info).",
		params: {
			profile: PROFILE_PARAM,
			cap: INFO_CAP
		},
		custom: async function esxiHostList(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const found = await runGovc(config.govcPath, ["find", "-type", "h", "-json"], {
				env,
				timeoutMs: config.defaultTimeoutMs,
				maxBufferBytes: config.maxOutputBytes
			});
			let paths = [];
			try {
				const parsed = JSON.parse(found.stdout);
				if (Array.isArray(parsed)) paths = parsed;
			} catch {
				/* not json */
			}
			if (paths.length === 0) return { kind: "ok", text: "(no hosts found)" };
			const batch = paths.slice(0, args.cap ?? config.infoCap);
			const tables = [];
			for (const path of batch) {
				const info = await runGovc(config.govcPath, ["host.info", "-json", "-host", path], {
					env,
					timeoutMs: config.defaultTimeoutMs,
					maxBufferBytes: config.maxOutputBytes
				});
				const table = formatHostInfoJson(info.stdout);
				if (table !== undefined) tables.push(table.split("\n").slice(1).join("\n"));
			}
			const header = "NAME\tCONN\tPOWER\tMAINT\tPRODUCT\tVERSION\tBUILD\tCPU\tCORES\tMEM\tCPU%";
			const footer = paths.length > batch.length ? `\n(+${paths.length - batch.length} more hosts not enriched; raise the cap for more)` : "";
			return { kind: "ok", text: truncateOutput([header, ...tables].join("\n") + footer, config.maxOutputChars) };
		}
	},
	{
		name: "esxi_host_info",
		description: "Full details for one host (govc host.info -json): product, version, hardware, runtime state, maintenance mode.",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host name or inventory path.", { required: true })
		},
		build(args) {
			return { argv: ["host.info", "-json", "-host", args.host] };
		},
		format(outputs) {
			return formatHostInfoJson(outputs[0]);
		}
	},
	{
		name: "esxi_host_maintenance",
		description: "Enter or exit maintenance mode for a host (govc host.maintenance.enter / host.maintenance.exit). Entering moves workloads off the host; requires approval.",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true }),
			mode: S("string", "enter or exit.", { required: true, enum: ["enter", "exit"] }),
			timeout: S("integer", "Timeout in seconds (0 = no timeout).", { min: 0 }),
			evacuate: S("boolean", "Evacuate powered-off VMs before entering (default false).")
		},
		build(args) {
			const argv = [`host.maintenance.${args.mode}`];
			if (args.timeout !== undefined) argv.push("-timeout", String(args.timeout));
			if (args.evacuate) argv.push("-evacuate");
			argv.push(args.host);
			return { argv, timeoutMs: 600000 };
		},
		gate(args) {
			return `${args.mode === "enter" ? "Enter" : "Exit"} maintenance mode for host "${args.host}"`;
		}
	},
	{
		name: "esxi_host_power",
		description: "Reboot or shutdown a host (govc host.shutdown -r / host.shutdown -f). Requires approval.",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true }),
			operation: S("string", "reboot or shutdown.", { required: true, enum: ["reboot", "shutdown"] }),
			force: S("boolean", "Force shutdown when the host is not in maintenance mode.")
		},
		build(args) {
			const argv = ["host.shutdown"];
			if (args.operation === "reboot") argv.push("-r");
			if (args.force) argv.push("-f");
			argv.push(args.host);
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			return `${args.operation.toUpperCase()} host "${args.host}"`;
		}
	},
	{
		name: "esxi_host_esxcli",
		description: "Run esxcli commands against a host (govc host.esxcli) — the long tail of host-level administration: storage, network, software, services, system, hardware, etc. Examples: 'network ip route ipv4 list', 'storage vmfs list', 'system version get'. Host-level changes require approval.",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true }),
			args: S("string", "esxcli command line, e.g. 'storage vmfs list' or 'network firewall set -e false'.", { required: true })
		},
		build(args) {
			return { argv: ["host.esxcli", "-host", args.host, "--", ...splitArgs(args.args)], timeoutMs: 180000 };
		},
		gate() {
			return "Run esxcli on a host (host-level command)";
		}
	},
	{
		name: "esxi_host_add",
		description: "Add a host to vCenter — into a cluster (govc cluster.add) or into the datacenter host folder (govc host.add).",
		params: {
			profile: PROFILE_PARAM,
			hostname: S("string", "Hostname or IP of the host to add.", { required: true }),
			username: S("string", "Administration account on the host (typically root).", { required: true }),
			password: S("string", "Password for the administration account.", { required: true }),
			cluster: S("string", "Cluster to add the host into (cluster mode)."),
			datacenter: S("string", "Datacenter for datacenter mode (host.add)."),
			insecure: S("boolean", "Accept the host's SSL thumbprint without verification (noverify)."),
			license: S("string", "License key to assign (cluster mode).")
		},
		build(args) {
			const mode = args.cluster !== undefined;
			const argv = [mode ? "cluster.add" : "host.add"];
			if (mode) {
				argv.push("-cluster", args.cluster);
				if (args.license !== undefined) argv.push("-license", args.license);
			} else if (args.datacenter !== undefined) {
				const dc = args.datacenter.startsWith("/") ? args.datacenter : `/${args.datacenter}`;
				argv.push("-folder", `${dc}/host`);
			}
			if (args.insecure) argv.push("-noverify");
			argv.push("-hostname", args.hostname, "-username", args.username, "-password", args.password);
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			return `Add host "${args.hostname}" ${args.cluster ? `to cluster "${args.cluster}"` : "to the datacenter"}`;
		}
	},
	{
		name: "esxi_host_remove",
		description: "Remove a host from vCenter (govc host.remove). The host itself is untouched.",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true })
		},
		build(args) {
			return { argv: ["host.remove", args.host], timeoutMs: 300000 };
		},
		gate(args) {
			return `Remove host "${args.host}" from vCenter`;
		}
	},
	{
		name: "esxi_host_reconnect",
		description: "Reconnect a disconnected host to vCenter (govc host.reconnect).",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true })
		},
		build(args) {
			return { argv: ["host.reconnect", "-host", args.host], timeoutMs: 300000 };
		}
	},
	{
		name: "esxi_host_service",
		description: "Control a host service (govc host.service): start, stop, restart, status, enable, disable. Example: enable + start TSM-SSH for SSH access.",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true }),
			action: S("string", "Action.", { required: true, enum: ["start", "stop", "restart", "status", "enable", "disable"] }),
			service: S("string", "Service id, e.g. TSM-SSH, ntpd, vpxa.", { required: true })
		},
		build(args) {
			return { argv: ["host.service", "-host", args.host, args.action, args.service], timeoutMs: 180000 };
		},
		gate(args) {
			if (args?.action === "status") return undefined;
			return `${args.action} host service "${args.service}" on "${args.host}"`;
		}
	},
	{
		name: "esxi_host_option",
		description: "Read or set an advanced host option (govc host.option.ls / host.option.set), e.g. Config.HostAgent.log.level.",
		params: {
			profile: PROFILE_PARAM,
			host: S("string", "Host.", { required: true }),
			operation: S("string", "list shows matching options; set changes one.", { required: true, enum: ["list", "set"] }),
			name: S("string", "Option name (glob allowed for list), e.g. Config.HostAgent.*."),
			value: S("string", "Value to set (set).")
		},
		build(args) {
			if (args.operation === "list") {
				const argv = ["host.option.ls", "-host", args.host];
				if (args.name !== undefined) argv.push(args.name);
				return { argv };
			}
			return { argv: ["host.option.set", "-host", args.host, args.name, args.value] };
		},
		gate(args) {
			if (args?.operation === "set") return `Set host option "${args.name}" = "${args.value}" on "${args.host}"`;
			return undefined;
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// Clusters & resource pools
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_cluster_create",
		description: "Create a cluster in a datacenter (govc cluster.create).",
		params: {
			profile: PROFILE_PARAM,
			name: S("string", "Cluster name.", { required: true }),
			folder: S("string", "Inventory folder for the cluster (defaults to the datacenter host folder).")
		},
		build(args) {
			const argv = ["cluster.create"];
			if (args.folder !== undefined) argv.push("-folder", args.folder);
			argv.push(args.name);
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			return `Create cluster "${args.name}"`;
		}
	},
	{
		name: "esxi_cluster_info",
		description: "Cluster resource usage summary (govc cluster.usage): CPU/memory totals and usage across the cluster's hosts.",
		params: {
			profile: PROFILE_PARAM,
			cluster: S("string", "Cluster name or inventory path.", { required: true }),
			sharedOnly: S("boolean", "Summarize shared storage only.")
		},
		build(args) {
			const argv = ["cluster.usage"];
			if (args.sharedOnly) argv.push("-S");
			argv.push(args.cluster);
			return { argv };
		}
	},
	{
		name: "esxi_cluster_change",
		description: "Change cluster configuration (govc cluster.change): enable/disable DRS and HA, set DRS automation level and vmotion rate, VSAN, and more.",
		params: {
			profile: PROFILE_PARAM,
			cluster: S("string", "Cluster.", { required: true }),
			drsEnabled: S("boolean", "Enable DRS."),
			drsMode: S("string", "DRS automation level.", { enum: ["manual", "partiallyAutomated", "fullyAutomated"] }),
			drsVmotionRate: S("integer", "DRS vmotion rate (1-5).", { min: 1, max: 5 }),
			haEnabled: S("boolean", "Enable HA."),
			vsanEnabled: S("boolean", "Enable vSAN.")
		},
		build(args) {
			const argv = ["cluster.change"];
			if (args.drsEnabled !== undefined) argv.push(`-drs-enabled=${args.drsEnabled}`);
			if (args.drsMode !== undefined) argv.push("-drs-mode", args.drsMode);
			if (args.drsVmotionRate !== undefined) argv.push("-drs-vmotion-rate", String(args.drsVmotionRate));
			if (args.haEnabled !== undefined) argv.push(`-ha-enabled=${args.haEnabled}`);
			if (args.vsanEnabled !== undefined) argv.push(`-vsan-enabled=${args.vsanEnabled}`);
			argv.push(args.cluster);
			return { argv, timeoutMs: 300000 };
		},
		gate(args) {
			return `Change cluster configuration for "${args.cluster}"`;
		}
	},
	{
		name: "esxi_pool_list",
		description: "List resource pools with CPU/memory limits, reservations, and shares (govc pool.info).",
		params: {
			profile: PROFILE_PARAM,
			pool: S("string", "Optional pool path to show just one.")
		},
		build(args) {
			const argv = ["pool.info", "-json"];
			if (args.pool !== undefined) argv.push(args.pool);
			return { argv };
		},
		format(outputs) {
			return formatPoolInfoJson(outputs[0]);
		}
	},
	{
		name: "esxi_pool_create",
		description: "Create a resource pool (govc pool.create) with optional CPU/memory limits, reservations, and shares.",
		params: {
			profile: PROFILE_PARAM,
			pool: S("string", "Pool path, e.g. /dc1/host/Cluster1/Resources/MyPool (relative paths resolve against the datacenter host folder).", { required: true }),
			cpuLimit: S("integer", "CPU limit in MHz (-1 unlimited).", { min: -1 }),
			cpuReservation: S("integer", "CPU reservation in MHz.", { min: 0 }),
			cpuShares: S("string", "CPU shares level or number (low|normal|high|N)."),
			memLimit: S("integer", "Memory limit in MB (-1 unlimited).", { min: -1 }),
			memReservation: S("integer", "Memory reservation in MB.", { min: 0 }),
			memShares: S("string", "Memory shares level or number.")
		},
		build(args) {
			const argv = ["pool.create"];
			if (args.cpuLimit !== undefined) argv.push("-cpu.limit", String(args.cpuLimit));
			if (args.cpuReservation !== undefined) argv.push("-cpu.reservation", String(args.cpuReservation));
			if (args.cpuShares !== undefined) argv.push("-cpu.shares", args.cpuShares);
			if (args.memLimit !== undefined) argv.push("-mem.limit", String(args.memLimit));
			if (args.memReservation !== undefined) argv.push("-mem.reservation", String(args.memReservation));
			if (args.memShares !== undefined) argv.push("-mem.shares", args.memShares);
			argv.push(args.pool);
			return { argv };
		},
		gate(args) {
			return `Create resource pool "${args.pool}"`;
		}
	},
	{
		name: "esxi_pool_change",
		description: "Change a resource pool's CPU/memory allocation or rename it (govc pool.change).",
		params: {
			profile: PROFILE_PARAM,
			pool: S("string", "Pool path.", { required: true }),
			name: S("string", "New pool name (rename)."),
			cpuLimit: S("integer", "CPU limit in MHz (-1 unlimited).", { min: -1 }),
			cpuReservation: S("integer", "CPU reservation in MHz.", { min: 0 }),
			cpuShares: S("string", "CPU shares level or number."),
			memLimit: S("integer", "Memory limit in MB (-1 unlimited).", { min: -1 }),
			memReservation: S("integer", "Memory reservation in MB.", { min: 0 }),
			memShares: S("string", "Memory shares level or number.")
		},
		build(args) {
			const argv = ["pool.change"];
			if (args.name !== undefined) argv.push("-name", args.name);
			if (args.cpuLimit !== undefined) argv.push("-cpu.limit", String(args.cpuLimit));
			if (args.cpuReservation !== undefined) argv.push("-cpu.reservation", String(args.cpuReservation));
			if (args.cpuShares !== undefined) argv.push("-cpu.shares", args.cpuShares);
			if (args.memLimit !== undefined) argv.push("-mem.limit", String(args.memLimit));
			if (args.memReservation !== undefined) argv.push("-mem.reservation", String(args.memReservation));
			if (args.memShares !== undefined) argv.push("-mem.shares", args.memShares);
			argv.push(args.pool);
			return { argv };
		},
		gate(args) {
			return `Change resource pool "${args.pool}"`;
		}
	},
	{
		name: "esxi_pool_destroy",
		description: "Destroy a resource pool (govc pool.destroy); optionally its children too.",
		params: {
			profile: PROFILE_PARAM,
			pool: S("string", "Pool path.", { required: true }),
			children: S("boolean", "Remove child pools recursively.")
		},
		build(args) {
			const argv = ["pool.destroy"];
			if (args.children) argv.push("-children");
			argv.push(args.pool);
			return { argv };
		},
		gate(args) {
			return `Destroy resource pool "${args.pool}"`;
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// Tags, permissions, roles, licensing, tasks, events, alarms, library
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_tag_list",
		description: "List tag categories and tags (govc tags.category.ls / tags.ls), grouped by category.",
		params: {
			profile: PROFILE_PARAM,
			category: S("string", "Restrict to one category (optional).")
		},
		custom: async function esxiTagList(ctx, config, store, args) {
			validateArgs(this.params, args);
			const resolved = resolveProfileForCall(store, args);
			const password = await resolvePassword(ctx, resolved.profile);
			const env = buildEnv(resolved.profile, { password });
			const timeout = config.defaultTimeoutMs;
			const [categories, tags] = await Promise.all([
				runGovc(config.govcPath, ["tags.category.ls", "-json"], { env, timeoutMs: timeout, maxBufferBytes: config.maxOutputBytes }),
				runGovc(config.govcPath, args.category ? ["tags.ls", "-c", args.category] : ["tags.ls", "-json"], { env, timeoutMs: timeout, maxBufferBytes: config.maxOutputBytes })
			]);
			const formatted = formatTagsJson(tags.stdout, categories.stdout);
			return { kind: "ok", text: formatted ?? `${categories.stdout}\n${tags.stdout}` };
		}
	},
	{
		name: "esxi_tag_create",
		description: "Create a tag category (with cardinality and associable object types) or a tag inside a category (govc tags.category.create / tags.create).",
		params: {
			profile: PROFILE_PARAM,
			operation: S("string", "category creates a tag category; tag creates a tag.", { required: true, enum: ["category", "tag"] }),
			name: S("string", "Name of the category or tag.", { required: true }),
			category: S("string", "Category name (tag operation)."),
			description: S("string", "Description (optional)."),
			multi: S("boolean", "Allow multiple tags per object (category)."),
			types: S("string", "Associable object types, comma-separated, e.g. 'VirtualMachine,Datastore' (category; empty = all).")
		},
		build(args) {
			if (args.operation === "category") {
				const argv = ["tags.category.create"];
				if (args.description !== undefined) argv.push("-d", args.description);
				if (args.multi) argv.push("-m");
				for (const type of splitCsv(args.types)) argv.push("-t", type);
				argv.push(args.name);
				return { argv };
			}
			if (!args.category) throw new Error("invalid arguments: category is required for tag operation");
			const argv = ["tags.create", "-c", args.category];
			if (args.description !== undefined) argv.push("-d", args.description);
			argv.push(args.name);
			return { argv };
		},
		gate(args) {
			return `Create tag ${args.operation} "${args.name}"`;
		}
	},
	{
		name: "esxi_tag_attach",
		description: "Attach or detach a tag to an inventory object (govc tags.attach / tags.detach).",
		params: {
			profile: PROFILE_PARAM,
			operation: S("string", "attach or detach.", { required: true, enum: ["attach", "detach"] }),
			tag: S("string", "Tag name.", { required: true }),
			object: S("string", "Inventory path of the object, e.g. /dc1/vm/MyVM.", { required: true }),
			category: S("string", "Category (disambiguates the tag name; optional).")
		},
		build(args) {
			const argv = [`tags.${args.operation}`];
			if (args.category !== undefined) argv.push("-c", args.category);
			argv.push(args.tag, args.object);
			return { argv };
		},
		gate(args) {
			return `${args.operation} tag "${args.tag}" ${args.operation === "attach" ? "to" : "from"} "${args.object}"`;
		}
	},
	{
		name: "esxi_permission_list",
		description: "List permissions on an entity (or the whole vCenter) (govc permissions.ls).",
		params: {
			profile: PROFILE_PARAM,
			path: S("string", "Inventory path to list permissions for (default: root, includes inherited).")
		},
		build(args) {
			const argv = ["permissions.ls", "-json"];
			if (args.path !== undefined) argv.push(args.path);
			return { argv };
		},
		format(outputs) {
			return formatPermissionsJson(outputs[0]);
		}
	},
	{
		name: "esxi_permission_set",
		description: "Grant a permission to a principal (user or group) with a role on an entity, optionally propagating (govc permissions.set).",
		params: {
			profile: PROFILE_PARAM,
			principal: S("string", "User or group name, e.g. user@vsphere.local.", { required: true }),
			role: S("string", "Role name, e.g. Admin, ReadOnly, or a custom role.", { required: true }),
			path: S("string", "Inventory path to grant on (default: root)."),
			group: S("boolean", "Principal is a group name."),
			propagate: S("boolean", "Propagate to child entities (default true).")
		},
		build(args) {
			const argv = ["permissions.set", "-principal", args.principal, "-role", args.role];
			if (args.group) argv.push("-group");
			if (args.propagate === false) argv.push("-propagate=false");
			if (args.path !== undefined) argv.push(args.path);
			return { argv };
		},
		gate(args) {
			return `Grant role "${args.role}" to ${args.group ? "group" : "user"} "${args.principal}"${args.path ? ` on "${args.path}"` : " (root)"}`;
		}
	},
	{
		name: "esxi_permission_remove",
		description: "Remove a principal's permission from an entity (govc permissions.remove).",
		params: {
			profile: PROFILE_PARAM,
			principal: S("string", "User or group name.", { required: true }),
			path: S("string", "Inventory path (default: root)."),
			group: S("boolean", "Principal is a group name."),
			force: S("boolean", "Ignore NotFound errors.")
		},
		build(args) {
			const argv = ["permissions.remove", "-principal", args.principal];
			if (args.group) argv.push("-group");
			if (args.force) argv.push("-f");
			if (args.path !== undefined) argv.push(args.path);
			return { argv };
		},
		gate(args) {
			return `Remove permission of ${args.group ? "group" : "user"} "${args.principal}"${args.path ? ` on "${args.path}"` : " (root)"}`;
		}
	},
	{
		name: "esxi_role_list",
		description: "List roles and their privilege counts (govc role.ls).",
		params: {
			profile: PROFILE_PARAM,
			role: S("string", "Optional role name to list its privileges.")
		},
		build(args) {
			const argv = ["role.ls", "-json"];
			if (args.role !== undefined) argv.push(args.role);
			return { argv };
		},
		format(outputs) {
			return formatRolesJson(outputs[0]);
		}
	},
	{
		name: "esxi_role_create",
		description: "Create a role (govc role.create) with a list of privileges.",
		params: {
			profile: PROFILE_PARAM,
			name: S("string", "Role name.", { required: true }),
			privileges: S("string", "Privilege ids to include, comma-separated (empty = no privileges).")
		},
		build(args) {
			const argv = ["role.create"];
			for (const privilege of splitCsv(args.privileges)) argv.push(privilege);
			argv.push(args.name);
			return { argv };
		},
		gate(args) {
			return `Create role "${args.name}"`;
		}
	},
	{
		name: "esxi_license_list",
		description: "List vCenter/ESXi licenses (govc license.ls).",
		params: {
			profile: PROFILE_PARAM
		},
		build() {
			return { argv: ["license.ls", "-json"] };
		},
		format(outputs) {
			return formatLicensesJson(outputs[0]);
		}
	},
	{
		name: "esxi_license_add",
		description: "Add a license key to vCenter's license inventory (govc license.add).",
		params: {
			profile: PROFILE_PARAM,
			key: S("string", "License key (XXXXX-XXXXX-...).", { required: true })
		},
		build(args) {
			return { argv: ["license.add", args.key] };
		},
		gate(args) {
			return "Add a license key to the license inventory";
		}
	},
	{
		name: "esxi_license_assign",
		description: "Assign (or remove the assignment of) a license key to a host or cluster (govc license.assign).",
		params: {
			profile: PROFILE_PARAM,
			key: S("string", "License key.", { required: true }),
			host: S("string", "Host to assign to."),
			cluster: S("string", "Cluster to assign to."),
			remove: S("boolean", "Remove the assignment instead of assigning.")
		},
		build(args) {
			const argv = ["license.assign"];
			if (args.host !== undefined) argv.push("-host", args.host);
			if (args.cluster !== undefined) argv.push("-cluster", args.cluster);
			if (args.remove) argv.push("-remove");
			argv.push(args.key);
			return { argv };
		},
		gate(args) {
			return `${args.remove ? "Remove license assignment" : `Assign license ${args.key.slice(0, 8)}…`} ${args.host ? `to host "${args.host}"` : ""}${args.cluster ? `to cluster "${args.cluster}"` : ""}`;
		}
	},
	{
		name: "esxi_task_list",
		description: "List recent vCenter tasks (govc tasks): entity, operation, state, result, times.",
		params: {
			profile: PROFILE_PARAM,
			limit: S("integer", "Last N tasks (default 25).", { min: 1 }),
			hours: S("integer", "Look back window in hours (default 24).", { min: 1 }),
			path: S("string", "Restrict to tasks on one inventory object.")
		},
		build(args) {
			const argv = ["tasks", "-b", `${args.hours ?? 24}h`, "-n", String(args.limit ?? 25)];
			if (args.path !== undefined) argv.push(args.path);
			return { argv };
		}
	},
	{
		name: "esxi_event_list",
		description: "List events for an object (govc events): vm events, host events, etc. Optionally filter by event type.",
		params: {
			profile: PROFILE_PARAM,
			path: S("string", "Inventory path, e.g. /dc1/vm/MyVM (default: all monitored objects)."),
			limit: S("integer", "Last N events (default 25).", { min: 1 }),
			types: S("string", "Event types to include, comma-separated, e.g. VmPoweredOffEvent,VmPoweredOnEvent.")
		},
		build(args) {
			const argv = ["events", "-n", String(args.limit ?? 25)];
			for (const type of splitCsv(args.types)) argv.push("-type", type);
			if (args.path !== undefined) argv.push(args.path);
			return { argv };
		}
	},
	{
		name: "esxi_alarm_list",
		description: "Show triggered or declared alarms (govc alarms).",
		params: {
			profile: PROFILE_PARAM,
			path: S("string", "Inventory path (default root).")
		},
		build(args) {
			const argv = ["alarms"];
			if (args.path !== undefined) argv.push(args.path);
			return { argv };
		}
	},
	{
		name: "esxi_library_list",
		description: "List content libraries, items, and files (govc library.ls).",
		params: {
			profile: PROFILE_PARAM,
			path: S("string", "Library path, e.g. /lib1 or /lib1/item1 (default: all).")
		},
		build(args) {
			const argv = ["library.ls", "-json"];
			if (args.path !== undefined) argv.push(args.path);
			return { argv };
		},
		format(outputs) {
			return formatLibrariesJson(outputs[0]);
		}
	},
	{
		name: "esxi_library_deploy",
		description: "Deploy a VM from a content-library OVF template (govc library.deploy).",
		params: {
			profile: PROFILE_PARAM,
			template: S("string", "Library item path of the OVF template, e.g. /lib1/ovf-template.", { required: true }),
			name: S("string", "New VM name (defaults to the template name)."),
			datastore: S("string", "Target datastore."),
			pool: S("string", "Target resource pool."),
			folder: S("string", "Target inventory folder."),
			host: S("string", "Target host.")
		},
		build(args) {
			const argv = ["library.deploy"];
			if (args.datastore !== undefined) argv.push("-ds", args.datastore);
			if (args.pool !== undefined) argv.push("-pool", args.pool);
			if (args.folder !== undefined) argv.push("-folder", args.folder);
			if (args.host !== undefined) argv.push("-host", args.host);
			argv.push(args.template);
			if (args.name !== undefined) argv.push(args.name);
			return { argv, timeoutMs: 600000 };
		},
		gate(args) {
			return `Deploy VM "${args.name ?? "(template name)"}" from library template "${args.template}"`;
		}
	},
	{
		name: "esxi_datacenter_create",
		description: "Create a datacenter (govc datacenter.create).",
		params: {
			profile: PROFILE_PARAM,
			name: S("string", "Datacenter name.", { required: true }),
			folder: S("string", "Inventory folder (default root).")
		},
		build(args) {
			const argv = ["datacenter.create"];
			if (args.folder !== undefined) argv.push("-folder", args.folder);
			argv.push(args.name);
			return { argv };
		},
		gate(args) {
			return `Create datacenter "${args.name}"`;
		}
	},
	// ─────────────────────────────────────────────────────────────────────────
	// Raw passthrough
	// ─────────────────────────────────────────────────────────────────────────
	{
		name: "esxi_run",
		description: "Run an arbitrary govc command against the selected connection: esxi_run {args: 'vm.power -off web-01'} executes `govc vm.power -off web-01`. Args are parsed safely (quotes/escapes) and passed as argv — never through a shell. Use this for anything the dedicated tools do not cover (vsan.*, alarm.*, option.*, import.ova, cluster.rule.*, dvs.*, device.*, vapp.*, etc.). Destructive subcommands trigger the approval gate.",
		params: {
			profile: PROFILE_PARAM,
			args: S("string", "govc command line, e.g. 'vsan.info ClusterA' or 'collect /dc1/vm/MyVM runtime.powerState'.", { required: true }),
			timeoutMs: S("integer", "Timeout in milliseconds (default from plugin config).", { min: 1000 })
		},
		build(args) {
			const argv = splitArgs(args.args);
			if (argv[0].startsWith("-")) throw new Error("invalid args: the govc subcommand must come first (no leading '-')");
			if (argv[0].includes("/") || argv[0].includes("\\") || argv[0].includes("..")) throw new Error(`invalid args: "${argv[0]}" is not a govc subcommand`);
			return { argv, timeoutMs: args.timeoutMs };
		},
		gate(args) {
			if (typeof args?.args !== "string") return undefined;
			const tokens = splitArgs(args.args);
			const first = tokens[0] ?? "";
			if (DESTRUCTIVE_PREFIXES.some((prefix) => first === prefix || first.startsWith(`${prefix}.`))) {
				return `Run govc command: ${first} ${tokens.slice(1, 5).join(" ")}`;
			}
			if (first === "vm.power") {
				const flag = tokens.find((t) => t.startsWith("-") && !t.startsWith("-wait") && !t.startsWith("-on"));
				if (flag) return `Run govc command: ${args.args}`;
			}
			return undefined;
		}
	}
];

/** govc subcommand prefixes treated as potentially destructive by esxi_run's gate. */
const DESTRUCTIVE_PREFIXES = [
	"vm.destroy", "vm.disk", "vm.network", "vm.migrate", "vm.change", "vm.markastemplate", "vm.markasvm",
	"vm.unregister", "vm.register", "vm.clone", "vm.create", "vm.instantclone", "snapshot.remove", "snapshot.revert",
	"guest.start", "guest.upload", "guest.rm", "guest.rmdir", "guest.kill", "guest.mkdir", "guest.mv",
	"guest.chmod", "guest.chown", "guest.touch", "guest.mktemp",
	"datastore.cp", "datastore.mv", "datastore.rm", "datastore.mkdir", "datastore.upload", "datastore.create",
	"datastore.remove", "datastore.cluster.change", "datastore.disk", "datastore.maintenance",
	"host.add", "host.remove", "host.reconnect", "host.maintenance", "host.shutdown", "host.disconnect",
	"host.esxcli", "host.service", "host.option.set", "host.date.change", "host.account", "host.cert",
	"host.vswitch", "host.portgroup", "host.vnic", "host.storage.mark", "host.storage.partition", "host.autostart",
	"cluster.add", "cluster.create", "cluster.change", "cluster.mv", "cluster.group", "cluster.rule", "cluster.override",
	"cluster.module", "cluster.vlcm.enable", "cluster.stretch", "cluster.draft",
	"pool.create", "pool.change", "pool.destroy",
	"tags.create", "tags.category.create", "tags.category.update", "tags.category.rm", "tags.update", "tags.rm",
	"tags.attach", "tags.detach",
	"permissions.set", "permissions.remove",
	"role.create", "role.update", "role.remove",
	"license.add", "license.assign", "license.remove", "license.label.set",
	"library.create", "library.rm", "library.update", "library.deploy", "library.import", "library.evict",
	"library.sync", "library.publish", "library.checkin", "library.checkout", "library.clone", "library.cp",
	"library.session.rm", "library.subscriber", "library.trust",
	"dvs.create", "dvs.add", "dvs.change", "dvs.portgroup.add", "dvs.portgroup.change",
	"device.add", "device.remove", "device.connect", "device.disconnect", "device.cdrom", "device.floppy",
	"device.serial", "device.usb", "device.pci", "device.scsi", "device.sata", "device.clock",
	"object.destroy", "object.mv", "object.rename", "object.method",
	"option.set", "fields.add", "fields.set", "fields.rm",
	"vcsa.shutdown.reboot", "vcsa.shutdown.poweroff", "vcsa.access",
	"vsan.change", "disk.create", "disk.attach", "disk.detach", "disk.rm", "disk.metadata.update",
	"import.ova", "import.ovf", "vapp.destroy", "vapp.power"
];
