// dsh-esxi smoke test: loads the plugin with a fake cordis ctx and a fake
// `govc` binary, then exercises connect/profiles/about/list/gate/run paths.
// Run: node test/smoke.mjs
// dsh-esxi 冒烟测试：以伪造的 cordis ctx 与伪造的 `govc` 二进制加载插件，覆盖
// connect/profiles/about/list/gate/run 等路径。运行：node test/smoke.mjs
import { mkdtemp, mkdir, writeFile, chmod, rm, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../lib/index.js");
const { apply } = plugin;

// ── fake govc binary ─────────────────────────────────────────────────────────
const FAKE_GOVC = `#!/bin/sh
case "$1" in
  version) echo "govc 0.44.0 (fake)" ;;
  about)
    echo "Name:         VMware vCenter Server (FAKE)"
    echo "Vendor:       VMware, Inc."
    echo "Version:      8.0.3"
    echo "Build:        22617221"
    echo "OS type:      linux-x64"
    echo "GOVC_URL_ENV=$GOVC_URL"
    echo "GOVC_DC_ENV=$GOVC_DATACENTER"
    echo "GOVC_PASSWORD_ENV=\${GOVC_PASSWORD:-<unset>}"
    ;;
  find)
    # $2 = -type, $3 = type letters (comma-separated allowed)
    case "$3" in
      d) echo '["/DC1"]' ;;
      c) echo '["/DC1/host/Cluster1"]' ;;
      h) echo '["/DC1/host/esxi-1"]' ;;
      m) echo '["/DC1/vm/VM1","/DC1/vm/VM2"]' ;;
      s) echo '["/DC1/datastore/datastore1"]' ;;
      n,g) echo '["/DC1/network/VM Network","/DC1/network/DVS/portgroup1"]' ;;
      p) echo '["/DC1/host/Cluster1/Resources"]' ;;
      *) echo '[]' ;;
    esac
    ;;
  vm.info)
    echo '{"virtualMachines":[{"name":"VM1","runtime":{"powerState":"poweredOn","connectionState":"connected","host":{"name":"esxi-1"}},"config":{"name":"VM1","numCPU":2,"memorySizeMB":4096,"datastoreUrl":[{"name":"datastore1"}]},"guest":{"ipAddress":"10.0.0.1","hostName":"vm1.example.com","toolsStatus":"toolsOk"}},{"name":"VM2","runtime":{"powerState":"poweredOff","connectionState":"connected"},"config":{"name":"VM2","numCPU":4,"memorySizeMB":8192,"datastoreUrl":[{"name":"datastore1"}]},"guest":{}}]}'
    ;;
  host.info)
    echo '{"HostSystems":[{"Name":"esxi-1","Runtime":{"ConnectionState":"connected","PowerState":"poweredOn","InMaintenanceMode":false},"Summary":{"Config":{"Product":{"Name":"VMware ESXi","Version":"8.0.2","Build":"22380479"}},"Hardware":{"CpuModel":"Intel Xeon Gold 6338","NumCpuCores":32,"MemorySize":257698037760},"QuickStats":{"OverallCpuUsage":7}}}]}'
    ;;
  datastore.info)
    echo '{"Datastores":[{"Summary":{"Name":"datastore1","Type":"VMFS","Capacity":1099511627776,"FreeSpace":549755813888}}]}'
    ;;
  pool.info)
    echo '{"ResourcePools":[{"Name":"Resources","Summary":{"Config":{"CpuAllocation":{"Limit":-1,"Reservation":0,"Shares":{"Level":"normal"}},"MemoryAllocation":{"Limit":-1,"Reservation":0,"Shares":{"Level":"normal"}}}}}]}'
    ;;
  permissions.ls)
    echo '[{"Principal":"admin@vsphere.local","Role":"Admin","Propagate":true,"Entity":{"Type":"Folder","Value":"group-d1"}}]'
    ;;
  role.ls)
    echo '[{"Name":"Admin","Privilege":["System.Anonymous","System.View"]}]'
    ;;
  license.ls)
    echo '[{"LicenseKey":"XXXXX-00000-11111-22222-33333","Name":"vSphere 8 Enterprise Plus","Total":0,"Used":0,"EditionKey":"esx"}]'
    ;;
  tags.category.ls)
    echo '[{"Id":"urn:vmomi:InventoryServiceCategory:1","Name":"env","Cardinality":"SINGLE","AssociableTypes":["VirtualMachine"]}]'
    ;;
  tags.ls)
    echo '[{"Id":"urn:vmomi:InventoryServiceTag:1","Name":"prod","CategoryID":"urn:vmomi:InventoryServiceCategory:1"}]'
    ;;
  library.ls)
    echo '[{"ID":"lib-1","Name":"templates","Kind":"Library"},{"ID":"item-1","Name":"ubuntu-22.04","Kind":"Item"}]'
    ;;
  export.ovf)
    for last in "$@"; do dest="$last"; done
    mkdir -p "$dest"
    echo "fake-ovf" > "$dest/x.ovf"
    echo "Exported to $dest"
    ;;
  device.cdrom.insert)
    echo "CDROM-INSERT $*"
    ;;
  device.cdrom.eject)
    echo "CDROM-EJECT $*"
    ;;
  device.cdrom.add)
    echo "CDROM-ADD $*"
    ;;
  device.connect)
    echo "DEVICE-CONNECT $*"
    ;;
  device.disconnect)
    echo "DEVICE-DISCONNECT $*"
    ;;
  device.serial.add)
    echo "serialport-9001"
    ;;
  device.serial.connect)
    echo "SERIAL-CONNECT $*"
    ;;
  vm.disk.create)
    echo "DISK-CREATE $*"
    ;;
  vm.clone)
    case "$*" in
      *licensetest*) echo "fake govc: vm.clone failed: The operation is not supported on the object." >&2; exit 1 ;;
      *) echo "CLONE $*" ;;
    esac
    ;;
  snapshot.tree)
    echo "snap1"
    ;;
  snapshot.create)
    echo "SNAP $*"
    ;;
  snapshot.revert)
    echo "REVERT $*"
    ;;
  snapshot.remove)
    echo "SNAPREMOVE $*"
    ;;
  device.boot)
    echo "BOOT $*"
    ;;
  datastore.upload)
    echo "UPLOAD $*"
    ;;
  ls)
    echo "/DC1"
    ;;
  *)
    echo "fake govc: unknown command: $*" >&2
    exit 1
    ;;
esac
`;

// ── fake ctx ─────────────────────────────────────────────────────────────────
function fakeCredentials(dir) {
	const file = join(dir, "creds.json");
	const values = new Map();
	return {
		async set(ref, value) {
			values.set(ref, value);
			await writeFile(file, JSON.stringify(Object.fromEntries(values)));
		},
		async unset(ref) {
			values.delete(ref);
			await writeFile(file, JSON.stringify(Object.fromEntries(values)));
		},
		async resolve(ref) {
			if (values.has(ref)) return { value: values.get(ref), source: "file" };
			if (process.env[ref]) return { value: process.env[ref], source: "env" };
			return undefined;
		},
		async describe(ref) {
			return { configured: values.has(ref), source: "file", writable: true };
		}
	};
}

/**
* Fake host Settings service: registers namespaces with a real schemastery
* schema (values resolved with the schema's defaults), supports watch and
* document replacement so the settings surface can be exercised end to end.
*/
function fakeSettings(initialDocuments = {}) {
	const registrations = new Map();
	const scopes = new Map();
	const documents = new Map(Object.entries(initialDocuments));
	const watchers = new Map();
	return {
		register(ns, schema) {
			if (registrations.has(ns)) throw new Error(`duplicate settings namespace ${ns}`);
			registrations.set(ns, schema);
			const resolve = () => schema(documents.get(ns) ?? {});
			let current = resolve();
			const scope = {
				get: () => current,
				watch(callback) {
					const set = watchers.get(ns) ?? new Set();
					watchers.set(ns, set);
					set.add(callback);
					return () => set.delete(callback);
				},
				update: async (patch) => {
					documents.set(ns, { ...(documents.get(ns) ?? {}), ...patch });
					current = resolve();
					for (const callback of watchers.get(ns) ?? []) callback();
					return current;
				},
				replace: async (section) => {
					documents.set(ns, section);
					current = resolve();
					for (const callback of watchers.get(ns) ?? []) callback();
					return current;
				}
			};
			scopes.set(ns, { resolve, setCurrent: (value) => {
				current = value;
			} });
			return scope;
		},
		describe() {
			return { namespaces: [...registrations.keys()].map((ns) => ({ ns })) };
		},
		get(ns) {
			const schema = registrations.get(ns);
			return schema === undefined ? undefined : schema(documents.get(ns) ?? {});
		},
		registeredNamespaces: () => [...registrations.keys()],
		async setDocument(ns, value) {
			documents.set(ns, value);
			const holder = scopes.get(ns);
			if (holder) holder.setCurrent(holder.resolve());
			for (const callback of watchers.get(ns) ?? []) callback();
		}
	};
}

function fakeCtx(dir, settings) {
	const registered = new Map();
	const sections = [];
	let gate = null;
	const credentials = fakeCredentials(dir);
	const ctx = {
		logger: { info() {}, warn() {}, error() {} },
		tools: {
			register(def) {
				if (registered.has(def.name)) throw new Error(`duplicate tool ${def.name}`);
				registered.set(def.name, def);
			}
		},
		systemPrompt: {
			section(section) {
				sections.push(section);
			}
		},
		on(event, handler) {
			if (event === "tools/pre-execute") gate = handler;
		},
		get(service) {
			if (service === "credentials") return credentials;
			if (service === "settings") return settings;
			return undefined;
		},
		// Cordis-like inject: invoke the callback immediately with a scoped ctx
		// that resolves services through the same `get` seam.
		inject(services, callback) {
			callback({ get: (service) => ctx.get(service) });
			return () => {};
		}
	};
	return { ctx, registered, sections, gate: () => gate };
}

// ── assertions ───────────────────────────────────────────────────────────────
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

const dir = await mkdtemp(join(tmpdir(), "dsh-esxi-"));
try {
	await mkdir(join(dir, "bin"), { recursive: true });
	const govcPath = join(dir, "bin", "govc");
	await writeFile(govcPath, FAKE_GOVC);
	await chmod(govcPath, 0o755);

	const profilesFile = join(dir, "profiles.json");
	const settings = fakeSettings({
		"dsh-esxi": {
			govcPath: govcPath,
			defaultTimeoutMs: 4000,
			profiles: [{
				name: "panel-prod",
				url: "vc-panel.example.com",
				username: "admin@vsphere.local",
				password: "panelpw",
				insecure: true,
				datacenter: "DC1"
			}]
		}
	});
	const { ctx, registered, sections, gate } = fakeCtx(dir, settings);
	const config = {
		govcPath,
		profilesFile,
		defaultTimeoutMs: 5000,
		longTimeoutMs: 5000,
		maxOutputChars: 20000,
		infoCap: 10,
		inventoryMaxItems: 10
	};
	await apply.call(plugin, ctx, config);

	// ── settings surface (host registration; exec-dependent checks below) ───
	// The surface activates asynchronously through ctx.inject (fire-and-forget
	// by design, so boot never blocks); poll for the namespace registration.
	const waitFor = async (condition, timeoutMs = 2000) => {
		const start = Date.now();
		while (!condition()) {
			if (Date.now() - start > timeoutMs) return false;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		return true;
	};
	check("settings namespace registered", await waitFor(() => settings.registeredNamespaces().includes("dsh-esxi")), settings.registeredNamespaces().join(","));
	check("settings document resolved through schema", settings.get("dsh-esxi").defaultTimeoutMs === 4000, JSON.stringify(settings.get("dsh-esxi").defaultTimeoutMs));

	check("plugin exports apply/inject/name", typeof apply === "function" && Array.isArray(plugin.inject) && typeof plugin.name === "string");
	check("systemPrompt section registered", sections.some((s) => s.name === "tool:esxi"));
	check("approval gate registered", gate() !== null);

	const names = [...registered.keys()];
	const expected = ["esxi_connect", "esxi_about", "esxi_vm_list", "esxi_vm_power", "esxi_vm_delete", "esxi_run", "esxi_doctor", "esxi_datastore_list", "esxi_inventory", "esxi_profiles", "esxi_disconnect", "esxi_set_default", "esxi_vm_export"];
	for (const tool of expected) check(`tool registered: ${tool}`, names.includes(tool), `missing ${tool}`);
	check("tool count >= 70", names.length >= 70, `got ${names.length}`);
	check("no duplicate tool names", new Set(names).size === names.length);

	const exec = async (name, args) => {
		const def = registered.get(name);
		if (!def) throw new Error(`tool ${name} not registered`);
		return def.execute(args, {});
	};

	// ── settings surface (exec-dependent checks) ────────────────────────────
	const panelProfiles = (await exec("esxi_profiles", {})).text;
	check("esxi_profiles marks settings-managed profile", panelProfiles.includes("panel-prod (default) (settings)"), panelProfiles);
	const panelAbout = (await exec("esxi_about", {})).text;
	check("settings profile password flows to govc", panelAbout.includes("GOVC_PASSWORD_ENV=panelpw"), panelAbout);
	check("settings-managed profiles never persisted", !(await readFile(profilesFile, "utf8").catch(() => "")).includes("panel-prod"), "profiles.json must not contain settings-managed profiles");

	// ── connect / profiles / about ──────────────────────────────────────────
	const connectText = (await exec("esxi_connect", {
		profile: "prod",
		url: "vc1.example.com",
		username: "admin@vsphere.local",
		password: "s3cret!",
		datacenter: "DC1"
	})).text;
	check("esxi_connect normalized url", connectText.includes("https://vc1.example.com/sdk"), connectText);
	check("esxi_connect reports stored password", connectText.includes("stored"));

	// connect with verify:true must resolve the STORED password when none is given
	const reconnect = (await exec("esxi_connect", {
		profile: "prod",
		url: "vc1.example.com",
		username: "admin@vsphere.local",
		verify: true
	})).text;
	check("esxi_connect verify resolves stored password", reconnect.includes("GOVC_PASSWORD_ENV=s3cret!"), reconnect);

	// second profile + default switch
	await exec("esxi_connect", { profile: "lab", url: "esxi-lab.internal", username: "root", password: "labpass" });
	await exec("esxi_set_default", { profile: "lab" });
	const profilesText = (await exec("esxi_profiles", {})).text;
	check("esxi_set_default switches default", profilesText.includes("lab (default)"), profilesText);
	check("esxi_profiles redacts passwords", !profilesText.includes("s3cret!") && !profilesText.includes("labpass"), profilesText);

	const aboutText = (await exec("esxi_about", {})).text;
	check("esxi_about ran govc with profile env", aboutText.includes("GOVC_URL_ENV=https://esxi-lab.internal/sdk"), aboutText);
	check("esxi_about shows version", aboutText.includes("8.0.3"), aboutText);

	// explicit per-call profile override
	const aboutProd = (await exec("esxi_about", { profile: "prod" })).text;
	check("per-call profile override", aboutProd.includes("GOVC_URL_ENV=https://vc1.example.com/sdk"), aboutProd);

	// ── inventory ───────────────────────────────────────────────────────────
	const inventory = (await exec("esxi_inventory", {})).text;
	check("esxi_inventory top level", inventory.includes("Top level:"), inventory);
	check("esxi_inventory counts vms", /vms: 2/.test(inventory), inventory);
	check("esxi_inventory counts hosts", /hosts: 1/.test(inventory), inventory);
	check("esxi_inventory lists names", inventory.includes("VM1, VM2") && inventory.includes("Cluster1"), inventory);

	// ── vm list with details ────────────────────────────────────────────────
	const vmList = (await exec("esxi_vm_list", { details: true, cap: 5 })).text;
	check("esxi_vm_list details table has VM1", vmList.includes("VM1"), vmList);
	check("esxi_vm_list details shows power state", vmList.includes("poweredOn"), vmList);
	check("esxi_vm_list details shows IP", vmList.includes("10.0.0.1"), vmList);

	const vmInfo = (await exec("esxi_vm_info", { vm: "VM1,VM2" })).text;
	check("esxi_vm_info multi-VM", vmInfo.includes("VM1") && vmInfo.includes("VM2"), vmInfo);

	// ── host / datastore / pools / admin formatters ─────────────────────────
	const hostList = (await exec("esxi_host_list", {})).text;
	check("esxi_host_list shows host", hostList.includes("esxi-1"), hostList);
	check("esxi_host_list shows version", hostList.includes("8.0.2") && hostList.includes("32"), hostList);

	const hostInfo = (await exec("esxi_host_info", { host: "esxi-1" })).text;
	check("esxi_host_info details", hostInfo.includes("Intel Xeon Gold 6338"), hostInfo);

	const dsList = (await exec("esxi_datastore_list", {})).text;
	check("esxi_datastore_list shows capacity", dsList.includes("1.0 TB"), dsList);
	check("esxi_datastore_list shows free", dsList.includes("512.0 GB"), dsList);

	const pools = (await exec("esxi_pool_list", {})).text;
	check("esxi_pool_list formatted", pools.includes("Resources"), pools);

	const perms = (await exec("esxi_permission_list", {})).text;
	check("esxi_permission_list formatted", perms.includes("admin@vsphere.local") && perms.includes("Admin"), perms);

	const roles = (await exec("esxi_role_list", {})).text;
	check("esxi_role_list formatted", roles.includes("Admin"), roles);

	const licenses = (await exec("esxi_license_list", {})).text;
	check("esxi_license_list formatted", licenses.includes("vSphere 8 Enterprise Plus"), licenses);

	const tags = (await exec("esxi_tag_list", {})).text;
	check("esxi_tag_list grouped", tags.includes("prod") && tags.includes("env"), tags);

	const libraries = (await exec("esxi_library_list", {})).text;
	check("esxi_library_list formatted", libraries.includes("templates"), libraries);

	// ── export + OVA bundling ───────────────────────────────────────────────
	const exportDir = join(dir, "ovf-out");
	const exportText = (await exec("esxi_vm_export", { vm: "VM1", destination: exportDir, ova: true })).text;
	check("esxi_vm_export runs export.ovf", exportText.includes("Exported"), exportText);
	check("esxi_vm_export bundles OVA", exportText.includes("Bundled OVA"), exportText);
	check("esxi_vm_export ova file exists", await existsSync(`${exportDir}.ova`), `${exportDir}.ova`);

	// ── gate behavior ───────────────────────────────────────────────────────
	let nextCalled = 0;
	const next = () => {
		nextCalled += 1;
		return { continued: true };
	};
	const g = gate();
	const deleteDecision = g({ name: "esxi_vm_delete", arguments: { vm: "web-01" } }, next);
	check("gate asks for vm_delete", deleteDecision?.kind === "ask" && /PERMANENTLY delete/.test(deleteDecision.reason), JSON.stringify(deleteDecision));
	check("gate reason includes target profile", /profile "lab"/.test(deleteDecision?.reason ?? ""), deleteDecision?.reason);

	const powerOff = g({ name: "esxi_vm_power", arguments: { vm: "web-01", operation: "off" } }, next);
	check("gate asks for power off", powerOff?.kind === "ask" && /Power OFF/.test(powerOff.reason), JSON.stringify(powerOff));

	const powerOn = g({ name: "esxi_vm_power", arguments: { vm: "web-01", operation: "on" } }, next);
	check("gate passes power on", powerOn?.continued === true && nextCalled === 1, `powerOn gate=${JSON.stringify(powerOn)}`);

	const unknown = g({ name: "esxi_profiles", arguments: {} }, next);
	check("gate passes non-destructive tools", unknown?.continued === true && nextCalled === 2, `unknown gate=${JSON.stringify(unknown)}`);

	const runDestructive = g({ name: "esxi_run", arguments: { args: "datastore.rm -f /x" } }, next);
	check("gate asks for destructive esxi_run", runDestructive?.kind === "ask" && /datastore.rm/.test(runDestructive.reason), JSON.stringify(runDestructive));

	const runReadOnly = g({ name: "esxi_run", arguments: { args: "vsan.info ClusterA" } }, next);
	check("gate passes read-only esxi_run", runReadOnly?.continued === true && nextCalled === 3, JSON.stringify(runReadOnly));

	// A settings change to approveDestructive:false takes effect without restart:
	// the gate stops asking for destructive operations.
	await settings.setDocument("dsh-esxi", { ...settings.get("dsh-esxi"), approveDestructive: false });
	const gateAfterFlip = g({ name: "esxi_vm_delete", arguments: { vm: "web-01" } }, next);
	check("settings flip disarms the approval gate live", gateAfterFlip?.continued === true, JSON.stringify(gateAfterFlip));
	// Re-arm for the remaining gate assertions.
	await settings.setDocument("dsh-esxi", { ...settings.get("dsh-esxi"), approveDestructive: true });

	// ── esxi_run passthrough + arg safety ───────────────────────────────────
	let runError = null;
	try {
		await exec("esxi_run", { args: "vm.power -off web-01" });
	} catch (error) {
		runError = error.message;
	}
	check("esxi_run executes govc subcommand", runError !== null && runError.includes("fake govc: unknown command: vm.power -off web-01"), runError ?? "no error (fake govc should reject)");

	let invalid = null;
	try {
		await exec("esxi_run", { args: "vsan.info ClusterA; rm -rf /" });
	} catch (error) {
		invalid = error.message;
	}
	// The tokenizer keeps ';' inside a token; the fake govc rejects the whole
	// argv as one argument list — the key safety property is that no shell is
	// ever involved, so `rm` can never run as a separate command.
	check("esxi_run never touches a shell", invalid !== null && invalid.includes("unknown command"), invalid ?? "no error");

	// ── validation (missing/incorrect required args) ────────────────────────
	const expectThrow = async (name, args, pattern, label) => {
		try {
			await exec(name, args);
			check(label, false, "expected a validation error, got success");
		} catch (error) {
			check(label, pattern.test(error.message), error.message);
		}
	};
	await expectThrow("esxi_vm_power", { operation: "off" }, /missing required parameter "vm"/, "missing required param rejected");
	await expectThrow("esxi_vm_power", { vm: "x", operation: "explode" }, /must be one of/, "bad enum rejected");
	await expectThrow("esxi_vm_snapshot", { vm: "x", operation: "create" }, /name is required/, "snapshot create without name rejected");
	await expectThrow("esxi_vm_snapshot", { vm: "x", operation: "remove" }, /name .* removeAll/, "snapshot remove without name rejected");
	await expectThrow("esxi_vm_disk", { vm: "x", operation: "create", name: "d1" }, /size is required/, "disk create without size rejected");
	await expectThrow("esxi_vm_migrate", { vm: "x" }, /at least one of host, pool, or datastore/, "migrate without destination rejected");
	await expectThrow("esxi_vm_network", { vm: "x", operation: "remove" }, /device is required/, "network remove without device rejected");
	await expectThrow("esxi_portgroup_add", { name: "pg", mode: "distributed" }, /distributedSwitch is required/, "portgroup add without dvs rejected");
	await expectThrow("esxi_portgroup_remove", { name: "pg", mode: "distributed" }, /distributedSwitch is required/, "portgroup remove without dvs rejected");
	await expectThrow("esxi_guest_exec", { vm: "x", operation: "start", username: "u", password: "p" }, /command is required/, "guest start without command rejected");
	await expectThrow("esxi_guest_exec", { vm: "x", operation: "kill", username: "u", password: "p" }, /pid is required/, "guest kill without pid rejected");
	await expectThrow("esxi_tag_create", { operation: "tag", name: "t" }, /category is required/, "tag create without category rejected");
	await expectThrow("esxi_datastore_create", { operation: "nfs", name: "n", hosts: "h1" }, /remoteHost and remotePath are required/, "nfs datastore without remote rejected");
	await expectThrow("esxi_datastore_create", { operation: "vmfs", name: "n", hosts: "h1" }, /disk is required/, "vmfs datastore without disk rejected");
	await expectThrow("esxi_vm_iso", { vm: "x", operation: "insert" }, /iso is required/, "cdrom insert without iso rejected");

	// ── new tools (iso + boot order) ────────────────────────────────────────
	const isoInsert = (await exec("esxi_vm_iso", { vm: "x", operation: "insert", device: "cdrom-16001", datastore: "datastore1", iso: "iso/ubuntu.iso" })).text;
	check("esxi_vm_iso insert builds the cdrom.insert argv", isoInsert.includes("CDROM-INSERT device.cdrom.insert -vm x -device cdrom-16001 -ds datastore1 iso/ubuntu.iso"), isoInsert);
	check("esxi_vm_iso insert also connects the device", isoInsert.includes("DEVICE-CONNECT device.connect -vm x cdrom-16001"), isoInsert);
	const isoEject = (await exec("esxi_vm_iso", { vm: "x", operation: "eject" })).text;
	check("esxi_vm_iso eject defaults to the first CD-ROM", isoEject.includes("CDROM-EJECT device.cdrom.eject -vm x"), isoEject);
	const isoAdd = (await exec("esxi_vm_iso", { vm: "x", operation: "add", controller: "ide-200" })).text;
	check("esxi_vm_iso add passes the controller", isoAdd.includes("CDROM-ADD device.cdrom.add -vm x -controller ide-200"), isoAdd);
	const bootOrder = (await exec("esxi_vm_boot", { vm: "x", order: "cdrom,disk", delay: 500, secure: false })).text;
	check("esxi_vm_boot builds the device.boot argv", bootOrder.includes("BOOT device.boot -vm x -order cdrom,disk -delay 500 -secure=false"), bootOrder);

	// ── field-hardened behaviors (datastore defaulting, flag order, license errors) ──
	const diskCreate = (await exec("esxi_vm_disk", { vm: "VM1", operation: "create", name: "VM1/disk2", size: "1GB" })).text;
	check("esxi_vm_disk create defaults the datastore to the VM's own", diskCreate.includes("DISK-CREATE vm.disk.create -vm VM1 -name VM1/disk2 -size 1GB -ds datastore1"), diskCreate);
	const snapCreate = (await exec("esxi_vm_snapshot", { vm: "x", operation: "create", name: "snap1", description: "baseline", memory: false })).text;
	check("esxi_vm_snapshot create keeps flags before the positional name", snapCreate.includes("snapshot.create -vm x -d baseline -m=false snap1"), snapCreate);
	const cloneOk = (await exec("esxi_vm_clone", { vm: "VM1", name: "c1", powerOn: false })).text;
	check("esxi_vm_clone defaults the datastore to the source VM's", cloneOk.includes("CLONE vm.clone -vm VM1 -on=false -ds datastore1 c1"), cloneOk);
	await expectThrow("esxi_vm_clone", { vm: "VM1", name: "licensetest" }, /license does not permit CloneVM_Task/, "clone license failure translated");

	// ── esxi_seed_iso (autoinstall seed generation + upload) ───────────────
	const seedUpload = (await exec("esxi_seed_iso", {
		name: "ubuntu-seed",
		hostname: "web-1",
		username: "admin",
		password: "changeme",
		datastore: "datastore2",
		packages: "open-vm-tools,curl"
	})).text;
	check("esxi_seed_iso uploads the seed to the datastore", seedUpload.includes("Seed ISO uploaded: [datastore2] iso/ubuntu-seed.iso"), seedUpload);
	check("esxi_seed_iso reports the autoinstall target", seedUpload.includes("hostname=web-1, username=admin") && seedUpload.includes("open-vm-tools,curl"), seedUpload);
	check("esxi_seed_iso never leaks the plaintext password", !seedUpload.includes("changeme"), seedUpload.slice(0, 600));
	const seedGate = g({ name: "esxi_seed_iso", arguments: { name: "s", hostname: "h", username: "u", password: "p", datastore: "d" } }, next);
	check("gate asks for esxi_seed_iso", seedGate?.kind === "ask" && /seed ISO/.test(seedGate.reason), JSON.stringify(seedGate));

	// ── esxi_doctor ─────────────────────────────────────────────────────────
	const doctor = (await exec("esxi_doctor", {})).text;
	check("esxi_doctor finds govc", doctor.includes("govc 0.44.0 (fake)"), doctor);

	// ── degraded environment: missing govc + failing install + verify failure ──
	{
		await mkdir(join(dir, "degraded"), { recursive: true });
		const degradedSettings = fakeSettings({});
		const degraded = fakeCtx(join(dir, "degraded"), degradedSettings);
		await apply.call(plugin, degraded.ctx, {
			govcPath: "govc-definitely-missing",
			profilesFile: join(dir, "degraded", "profiles.json"),
			defaultTimeoutMs: 5000,
			longTimeoutMs: 5000
		});
		const degradedExec = async (name, args) => degraded.registered.get(name).execute(args, {});

		const doctorMissing = (await degradedExec("esxi_doctor", {})).text;
		check("esxi_doctor guides when govc missing", doctorMissing.includes("govc is required"), doctorMissing);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });
		try {
			const doctorInstall = (await degradedExec("esxi_doctor", { install: true })).text;
			check("esxi_doctor reports install failure as text", doctorInstall.includes("govc installation failed"), doctorInstall);
		} finally {
			globalThis.fetch = originalFetch;
		}

		const failedVerify = (await degradedExec("esxi_connect", {
			profile: "bad",
			url: "vc.example.com",
			username: "admin",
			password: "pw",
			verify: true
		})).text;
		check("esxi_connect verify reports failure as text", failedVerify.includes("Connectivity check FAILED"), failedVerify);
	}

	// ── disconnect + credential unset ───────────────────────────────────────
	const disconnect = (await exec("esxi_disconnect", { profile: "prod" })).text;
	check("esxi_disconnect confirms", disconnect.includes("Disconnected profile"), disconnect);
	await exec("esxi_disconnect", { profile: "lab" });
	const profilesAfter = (await exec("esxi_profiles", {})).text;
	check("esxi_profiles keeps the settings-managed profile", profilesAfter.includes("panel-prod (default) (settings)"), profilesAfter);
	const aboutPanel = (await exec("esxi_about", {})).text;
	check("about still works via the settings profile", aboutPanel.includes("GOVC_URL_ENV=https://vc-panel.example.com/sdk"), aboutPanel);
	// Removing the settings profiles drops them from the store; about then fails cleanly.
	await settings.setDocument("dsh-esxi", { ...settings.get("dsh-esxi"), profiles: [] });
	const aboutAfter = await exec("esxi_about", {}).catch((error) => ({ text: error.message }));
	check("about fails cleanly without profile", /no connection profile/.test(aboutAfter.text), aboutAfter.text);

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exit(1);
} finally {
	await rm(dir, { recursive: true, force: true });
}
