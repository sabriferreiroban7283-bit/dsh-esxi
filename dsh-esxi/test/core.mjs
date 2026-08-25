// dsh-esxi core unit tests: pure utilities and process-shaping helpers —
// splitArgs, normalizeUrl, passwordRefFor, formatting, profile-store
// persistence rules, runLocal failure shaping, and installGovc against a
// stubbed fetch serving a fake gzipped binary. No network, no harness.
// Run: node test/core.mjs
// dsh-esxi 核心单元测试：纯工具函数与进程封装——splitArgs、normalizeUrl、
// passwordRefFor、格式化、profile 存储持久化规则、runLocal 失败整形，以及以
// 桩 fetch 提供伪造 gzip 二进制的 installGovc。无网络、无 harness。
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import {
	EsxiCommandError,
	ProfileStore,
	fmtBytes,
	formatDatastoreInfoJson,
	formatHostInfoJson,
	formatLicensesJson,
	formatPoolInfoJson,
	formatVmInfoJson,
	installGovc,
	normalizeUrl,
	passwordRefFor,
	resolvePassword,
	runLocal,
	splitArgs,
	truncateOutput
} from "../lib/core.js";
import { applySettingsOps, isTrustedApiRequest, registerSettingsRoutes } from "../lib/settings-routes.js";
import { autoinstallUserData, buildSeedIso, sha512crypt } from "../lib/seediso.js";

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
const throws = (label, fn, pattern) => {
	try {
		fn();
		check(label, false, "expected a throw");
	} catch (error) {
		check(label, pattern.test(error.message), error.message);
	}
};

// ── splitArgs ────────────────────────────────────────────────────────────────
check("splitArgs plain", JSON.stringify(splitArgs("vm.power -off web-01")) === JSON.stringify(["vm.power", "-off", "web-01"]));
check("splitArgs double quotes", JSON.stringify(splitArgs('vm.info "My VM"')) === JSON.stringify(["vm.info", "My VM"]));
check("splitArgs single quotes", JSON.stringify(splitArgs("guest.start '/bin/echo hello'")) === JSON.stringify(["guest.start", "/bin/echo hello"]));
check("splitArgs escaped space", JSON.stringify(splitArgs("vm.info web\\-01")) === JSON.stringify(["vm.info", "web-01"]));
throws("splitArgs empty input", () => splitArgs(""), /empty command line/);
throws("splitArgs unterminated quote", () => splitArgs('vm.info "oops'), /unterminated quote/);

// ── normalizeUrl ─────────────────────────────────────────────────────────────
check("normalizeUrl bare host", normalizeUrl("vc01.example.com") === "https://vc01.example.com/sdk");
check("normalizeUrl with scheme", normalizeUrl("https://vc01.example.com") === "https://vc01.example.com/sdk");
check("normalizeUrl keeps path", normalizeUrl("https://vc01.example.com/sdk") === "https://vc01.example.com/sdk");
throws("normalizeUrl garbage", () => normalizeUrl("://bad"), /not parseable/);
throws("normalizeUrl empty", () => normalizeUrl("  "), /url is required/);

// ── passwordRefFor ───────────────────────────────────────────────────────────
check("passwordRefFor uses the documented ESXI_PASSWORD_ prefix", passwordRefFor("prod") === "ESXI_PASSWORD_PROD");
check("passwordRefFor sanitizes", passwordRefFor("My VC 1") === "ESXI_PASSWORD_MY_VC_1");
check("passwordRefFor empty fallback", passwordRefFor("") === "ESXI_PASSWORD_DEFAULT");

// ── formatting helpers ───────────────────────────────────────────────────────
check("fmtBytes zero", fmtBytes(0) === "0 B");
check("fmtBytes KB", fmtBytes(1024) === "1.0 KB");
check("fmtBytes GB", fmtBytes(549755813888) === "512.0 GB");
check("fmtBytes non-number", fmtBytes(undefined) === "?");
const long = "x".repeat(100);
check("truncateOutput under cap", truncateOutput("short", 100) === "short");
check("truncateOutput over cap", truncateOutput(long, 10).startsWith("xxxxxxxxxx\n[output truncated"), truncateOutput(long, 10).slice(0, 40));

// ── formatters: govc 0.52+ emits lowercase-first JSON keys ───────────────────
const vmLower = JSON.stringify({ virtualMachines: [{ name: "VM1", runtime: { powerState: "poweredOn", connectionState: "connected", host: { name: "esx1" } }, config: { numCPU: 2, memorySizeMB: 4096 }, guest: { ipAddress: "10.0.0.1", hostName: "vm1", toolsStatus: "toolsOk" }, datastore: [{ name: "ds1" }], network: [{ name: "VM Network" }] }] });
check("formatVmInfoJson reads lowercase keys", formatVmInfoJson(vmLower)?.includes("VM1\tpoweredOn\tconnected\t2\t4096\t10.0.0.1\tvm1\tesx1\ttoolsOk\tds1\tVM Network"), formatVmInfoJson(vmLower));
const vmUpper = JSON.stringify({ VirtualMachines: [{ Name: "VM2", Runtime: { PowerState: "poweredOff", ConnectionState: "connected" }, Config: { NumCpu: 4, MemorySizeMB: 8192 }, Guest: {} }] });
check("formatVmInfoJson still reads PascalCase keys", formatVmInfoJson(vmUpper)?.includes("VM2\tpoweredOff"), formatVmInfoJson(vmUpper));
const hostLower = JSON.stringify({ hostSystems: [{ name: "esx1", summary: { config: { product: { name: "VMware ESXi", version: "8.0.3", build: "24280767" } }, hardware: { cpuModel: "Xeon", numCpuCores: 64, memorySize: 1073741824 }, quickStats: { overallCpuUsage: 7 } }, runtime: { connectionState: "connected", powerState: "poweredOn", inMaintenanceMode: false } }] });
check("formatHostInfoJson reads lowercase keys", formatHostInfoJson(hostLower)?.includes("esx1\tconnected\tpoweredOn\tno\tVMware ESXi\t8.0.3\t24280767\tXeon\t64\t1.0 GB\t7%"), formatHostInfoJson(hostLower));
const dsLower = JSON.stringify({ datastores: [{ summary: { name: "datastore2", type: "VMFS", capacity: 2199023255552, freeSpace: 1099511627776, url: "/vmfs/volumes/x" } }] });
check("formatDatastoreInfoJson reads lowercase keys", formatDatastoreInfoJson(dsLower)?.includes("datastore2\tVMFS\t2.0 TB\t1.0 TB\t50%\t/vmfs/volumes/x"), formatDatastoreInfoJson(dsLower));
const poolLower = JSON.stringify({ resourcePools: [{ name: "Resources", summary: { config: { cpuAllocation: { limit: -1, reservation: 0, shares: { level: "normal" } }, memoryAllocation: { limit: -1, reservation: 0, shares: { level: "normal" } } } } }] });
check("formatPoolInfoJson reads lowercase keys", formatPoolInfoJson(poolLower)?.includes("Resources\t-1\t0\tnormal\t-1\t0\tnormal"), formatPoolInfoJson(poolLower));
const licenseLower = JSON.stringify([{ licenseKey: "K", name: "vSphere", total: 0, used: 0, editionKey: "esx" }]);
check("formatLicensesJson reads lowercase keys", formatLicensesJson(licenseLower)?.includes("K\tvSphere\t0\t0\tesx"), formatLicensesJson(licenseLower));

// ── resolvePassword precedence ───────────────────────────────────────────────
const ctxWithCreds = (values) => ({ get: (s) => s === "credentials" ? { resolve: async (ref) => values[ref] ? { value: values[ref] } : undefined } : undefined });
check("resolvePassword inline wins", await resolvePassword(ctxWithCreds({ X: "stored" }), { password: "inline", passwordRef: "X" }) === "inline");
check("resolvePassword credential ref", await resolvePassword(ctxWithCreds({ X: "stored" }), { passwordRef: "X" }) === "stored");
check("resolvePassword undefined without either", await resolvePassword(ctxWithCreds({}), {}) === undefined);
check("resolvePassword no ctx", await resolvePassword(undefined, { passwordRef: "X" }) === undefined);

// ── ProfileStore persistence rules ───────────────────────────────────────────
const dir = await mkdtemp(join(tmpdir(), "dsh-esxi-core-"));
try {
	const store = new ProfileStore(join(dir, "profiles.json"));
	await store.load();
	store.upsert("file-prod", { url: "https://a/sdk", username: "u", insecure: true });
	store.upsert("panel-prod", { url: "https://b/sdk", username: "u", insecure: true, settingsManaged: true, password: "pw" });
	store.setDefault("panel-prod");
	await store.save();
	const persisted = JSON.parse(await readFile(store.file, "utf8"));
	check("save skips settings-managed profiles", !("panel-prod" in persisted.profiles) && "file-prod" in persisted.profiles, JSON.stringify(persisted));
	check("save keeps the default marker", persisted.default === "panel-prod", JSON.stringify(persisted.default));

	const reloaded = new ProfileStore(store.file);
	await reloaded.load();
	check("reload roundtrip", reloaded.get("file-prod")?.url === "https://a/sdk" && reloaded.defaultName() === undefined, JSON.stringify(reloaded.names()));

	await writeFile(store.file, "{ not json", "utf8");
	const corrupt = new ProfileStore(store.file);
	let corruptError = null;
	try {
		await corrupt.load();
	} catch (error) {
		corruptError = error.message;
	}
	check("corrupt profiles file fails with guidance", corruptError !== null && /cannot read connection profiles/.test(corruptError), corruptError ?? "no error");
} finally {
	await rm(dir, { recursive: true, force: true });
}

// ── runLocal failure shaping ─────────────────────────────────────────────────
const echoOut = await runLocal(["sh", "-c", "echo ok; echo note >&2"]);
check("runLocal captures stdout/stderr", echoOut.stdout.trim() === "ok" && echoOut.stderr.trim() === "note", JSON.stringify(echoOut));
let localError = null;
try {
	await runLocal(["definitely-not-a-real-command-xyz", "arg"]);
} catch (error) {
	localError = error;
}
check("runLocal shapes failures as EsxiCommandError", localError instanceof EsxiCommandError && /\[exit code/.test(localError.message), localError?.message);
check("runLocal error carries command", localError?.command?.includes("definitely-not-a-real-command-xyz") === true, localError?.command);

// ── installGovc with a stubbed fetch ─────────────────────────────────────────
const installDir = join(dir, "bin");
const fakeScript = "#!/bin/sh\necho govc 9.9.9 fake\n";
const gzipped = gzipSync(Buffer.from(fakeScript));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
	check("installGovc fetched the legacy gz asset", /govc_linux_amd64\.gz$|govc_linux_arm64\.gz$/.test(String(url)), String(url));
	return { ok: true, status: 200, arrayBuffer: async () => gzipped.buffer.slice(gzipped.byteOffset, gzipped.byteOffset + gzipped.byteLength) };
};
try {
	const installed = await installGovc(installDir, { logger: { info() {}, warn() {} } });
	check("installGovc reports a binary path", typeof installed.binary === "string" && installed.binary.includes(installDir), installed.binary);
	check("installGovc verified the version", installed.version.includes("govc 9.9.9"), installed.version);
	const mode = (await stat(installed.binary)).mode & 0o111;
	check("installGovc makes the binary executable", mode !== 0, String(mode));
	const run = await runLocal([installed.binary]);
	check("installed binary actually runs", run.stdout.includes("govc 9.9.9"), run.stdout);
} finally {
	globalThis.fetch = originalFetch;
}

// ── settings bridge: trust fence + ops application ───────────────────────────
const trusted = ["192.168.2.252:3081", "10.0.0.5"];
const req = (headers) => ({ method: "POST", headers });
check("fence allows loopback", isTrustedApiRequest(req({ host: "127.0.0.1:3080" }), trusted) === true);
check("fence allows localhost", isTrustedApiRequest(req({ host: "localhost:3080" }), trusted) === true);
check("fence allows a trusted authority", isTrustedApiRequest(req({ host: "192.168.2.252:3081" }), trusted) === true);
check("fence allows a port-less trusted host on any port", isTrustedApiRequest(req({ host: "10.0.0.5:9999" }), trusted) === true);
check("fence rejects a port mismatch on a ported entry", isTrustedApiRequest(req({ host: "192.168.2.252:9999" }), trusted) === false);
check("fence rejects foreign hosts", isTrustedApiRequest(req({ host: "evil.example.com" }), trusted) === false);
check("fence rejects cross-site markers", isTrustedApiRequest(req({ host: "192.168.2.252:3081", "sec-fetch-site": "cross-site" }), trusted) === false);
check("fence rejects a mismatched origin", isTrustedApiRequest(req({ host: "192.168.2.252:3081", origin: "https://evil.example.com" }), trusted) === false);
check("fence accepts a same-origin marker", isTrustedApiRequest(req({ host: "192.168.2.252:3081", origin: "http://192.168.2.252:3081" }), trusted) === true);
check("fence rejects a missing host", isTrustedApiRequest(req({}), trusted) === false);

const fakeSettingsForOps = (user) => {
	let currentUser = { ...user };
	const replaceCalls = [];
	return {
		calls: replaceCalls,
		describe: () => [{ ns: "dsh-esxi", value: { ...currentUser }, user: { ...currentUser }, revision: 5 }],
		replace: async (ns, section, revision) => {
			replaceCalls.push({ ns, section: { ...section }, revision });
			currentUser = { ...section };
			return currentUser;
		}
	};
};
{
	const settings = fakeSettingsForOps({ govcPath: "/x", profiles: [] });
	await applySettingsOps(settings, "dsh-esxi", [
		{ op: "set", path: ["defaultTimeoutMs"], value: 4000 },
		{ op: "unset", path: ["govcPath"] }
	], 5);
	check("applySettingsOps sets and unsets on the user layer", settings.calls[0].section.defaultTimeoutMs === 4000 && !("govcPath" in settings.calls[0].section), JSON.stringify(settings.calls[0].section));
	check("applySettingsOps passes the revision through", settings.calls[0].revision === 5, String(settings.calls[0].revision));
	const rejects = async (label, promise, pattern) => {
		try {
			await promise;
			check(label, false, "expected rejection");
		} catch (error) {
			check(label, pattern.test(error.message), error.message);
		}
	};
	await rejects("applySettingsOps rejects deep paths", applySettingsOps(settings, "dsh-esxi", [{ op: "set", path: ["a", "b"], value: 1 }]), /invalid settings op/);
	await rejects("applySettingsOps rejects unknown ops", applySettingsOps(settings, "dsh-esxi", [{ op: "delete", path: ["a"] }]), /unknown settings op/);
}

// route registration shape (no real webserver in this harness)
{
	const routes = [];
	const webServer = { register: (options) => routes.push(options) };
	const settings = { describe: () => [], update: async () => {}, replace: async () => {} };
	const ctx = { get: (name) => (name === "webRuntime" ? { trustedHosts: [] } : undefined) };
	check("registerSettingsRoutes registers both routes", registerSettingsRoutes(ctx, settings, webServer) === true && routes.length === 2 && routes.every((r) => r.path.startsWith("/esxi/settings.")), JSON.stringify(routes.map((r) => r.path)));
	check("registerSettingsRoutes skips without a webserver", registerSettingsRoutes(ctx, settings, undefined) === false);
}

// ── seed ISO: sha512crypt + ISO9660 structure + autoinstall document ────────
check("sha512crypt matches openssl", sha512crypt("changeme", "dsh123") === "$6$dsh123$2/BoGY7Q.UC9nGBowvLc7vmo3H11oDFag0.PKHyCHAASy224XCNOAWEcldbck9jdzvvt.797PggfN9HH5yl.Y1", sha512crypt("changeme", "dsh123"));
check("sha512crypt shape", /^\$6\$[A-Za-z0-9./]{1,16}\$[A-Za-z0-9./]{86}$/.test(sha512crypt("pw", "salt")), sha512crypt("pw", "salt"));
const seed = buildSeedIso({ "user-data": "#cloud-config\nautoinstall:\n  version: 1\n", "meta-data": "instance-id: test\n" });
check("seed ISO is sector-aligned", seed.length > 0 && seed.length % 2048 === 0, String(seed.length));
const pvdSector = seed.subarray(16 * 2048, 17 * 2048);
check("seed ISO has a valid PVD", pvdSector[0] === 1 && pvdSector.toString("ascii", 1, 6) === "CD001" && pvdSector.toString("ascii", 40, 72).trim() === "cidata", JSON.stringify(pvdSector.toString("ascii", 40, 72)));
check("seed ISO PVD carries the volume space", pvdSector.readUInt32LE(80) === seed.length / 2048, String(pvdSector.readUInt32LE(80)));
const rootSector = seed.subarray(20 * 2048, 21 * 2048);
check("seed ISO root directory lists user-data and meta-data", rootSector.toString("ascii").includes("user-data") && rootSector.toString("ascii").includes("meta-data"), "");
const udSector = seed.subarray(21 * 2048, 22 * 2048);
check("seed ISO stores user-data in its own extent", udSector.toString("utf8").startsWith("#cloud-config\nautoinstall:"), udSector.toString("utf8", 0, 40));
const userData = autoinstallUserData({ hostname: "web-1", username: "admin", password: "changeme", packages: ["open-vm-tools"] });
check("autoinstall user-data carries hostname/username", userData.includes("hostname: web-1") && userData.includes("username: admin"), userData);
check("autoinstall user-data stores only the crypt hash", userData.includes('password: "$6$') && !userData.includes("changeme"), userData.slice(0, 400));
check("autoinstall user-data includes packages", userData.includes("- open-vm-tools"), userData);

// ── VMDK: sparse header parsing, raw conversion, descriptor geometry ────────
{
	const { parseSparseHeader, sparseVmdkToRaw, flatDescriptor } = await import("../lib/vmdk.js");
	const sector = 512;
	const buildSparse = (grains) => {
		// grains: array of Buffers (64KiB each) or null for unallocated
		const capacitySectors = grains.length * 128;
		const totalSectors = 330 + 2 + grains.length * 129; // header/GD + GT + per-grain GT-entry/data headroom
		const buf = Buffer.alloc(totalSectors * sector, 0);
		buf.write("KDMV", 0, "latin1");
		buf.writeUInt32LE(1, 4);
		buf.writeUInt32LE(3, 8);
		buf.writeBigUInt64LE(BigInt(capacitySectors), 12);
		buf.writeBigUInt64LE(128n, 20);
		buf.writeBigUInt64LE(1n, 28); // descriptor offset (sectors)
		buf.writeBigUInt64LE(20n, 36); // descriptor size
		buf.writeUInt32LE(512, 44); // numGTEsPerGT
		buf.writeBigUInt64LE(21n, 48); // rgd offset
		buf.writeBigUInt64LE(330n, 56); // gd offset (sector 330)
		buf.writeBigUInt64LE(640n, 64); // overhead
		// GD at sector 330: one GT per 512 grains; put GT right after the GD sector
		let gtSector = 331;
		for (let g = 0; g < grains.length; g += 512) {
			const gtIdx = Math.floor(g / 512);
			buf.writeUInt32LE(gtSector, 330 * sector + gtIdx * 4);
			for (let i = 0; i < 512 && g + i < grains.length; i++) {
				const data = grains[g + i];
				if (data) {
					const grainSector = gtSector + 1 + i * 128; // each grain spans 128 sectors
					buf.writeUInt32LE(grainSector, gtSector * sector + i * 4);
					data.copy(buf, grainSector * sector);
				} else {
					buf.writeUInt32LE(0xffffffff, gtSector * sector + i * 4);
				}
			}
			gtSector += 513;
		}
		return { buf, capacitySectors };
	};
	const grains = [Buffer.alloc(128 * sector, 0xab), null, Buffer.alloc(128 * sector, 0xcd)];
	const { buf, capacitySectors } = buildSparse(grains);
	const header = parseSparseHeader(buf.subarray(0, sector));
	check("vmdk sparse header parsed", header.magic === undefined && header.capacitySectors === capacitySectors && header.grainSectors === 128 && header.gdOffsetSectors === 330, JSON.stringify(header));
	const raw = sparseVmdkToRaw(buf);
	check("vmdk raw size matches capacity", raw.length === capacitySectors * sector, String(raw.length));
	check("vmdk allocated grain preserved", raw.subarray(0, 128 * sector).every((b) => b === 0xab), String(raw[0]));
	check("vmdk unallocated grain zeroed", raw.subarray(128 * sector, 256 * sector).every((b) => b === 0), String(raw[128 * sector]));
	check("vmdk second allocated grain preserved", raw.subarray(256 * sector).every((b) => b === 0xcd), String(raw[256 * sector]));
	const desc = flatDescriptor({ fileName: "x-flat.vmdk", capacitySectors });
	check("vmdk descriptor names the flat and uses valid geometry", desc.includes('createType="monolithicFlat"') && desc.includes('RW ' + capacitySectors + ' FLAT "x-flat.vmdk" 0') && /cylinders = "[1-9][0-9]*"/.test(desc) && !desc.includes('cylinders = "0"'), desc);
}

// ── auth-failure latch: one rejected login stops further spawns ─────────────
{
	const { runGovc, isAuthLatched, clearAuthLatch } = await import("../lib/core.js");
	const script = await mkdtemp(join(tmpdir(), "dsh-esxi-latch-"));
	const fake = join(script, "govc");
	await writeFile(fake, `#!/bin/sh\nn=$(cat "${join(script, "count")}" 2>/dev/null || echo 0)\necho $((n+1)) > "${join(script, "count")}"\necho "ServerFaultCode: Cannot complete login due to an incorrect user name or password." >&2\nexit 1\n`);
	await chmod(fake, 0o755);
	const env = { GOVC_URL: "https://latched.example/sdk", GOVC_USERNAME: "root", GOVC_PASSWORD: "bad" };
	let firstError = "";
	try {
		await runGovc(fake, ["about"], { env, timeoutMs: 5000 });
	} catch (error) {
		firstError = error.message;
	}
	check("auth rejection latches with guidance", firstError.includes("lock the ESXi account") && firstError.includes("incorrect user name or password"), firstError.slice(0, 120));
	check("auth latch is active for the URL", isAuthLatched(env.GOVC_URL) === true, String(isAuthLatched(env.GOVC_URL)));
	const before = await readFile(join(script, "count"), "utf8");
	let secondError = "";
	try {
		await runGovc(fake, ["about"], { env, timeoutMs: 5000 });
	} catch (error) {
		secondError = error.message;
	}
	const after = await readFile(join(script, "count"), "utf8");
	check("latched call fails fast without spawning", secondError.includes("STOP retrying") && before === after, `spawns ${before}->${after}, msg: ${secondError.slice(0, 80)}`);
	clearAuthLatch(env.GOVC_URL);
	check("latch clears explicitly", isAuthLatched(env.GOVC_URL) === false, String(isAuthLatched(env.GOVC_URL)));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
