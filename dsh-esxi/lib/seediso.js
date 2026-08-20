// dsh-esxi seed-ISO support: builds the cloud-init NoCloud "cidata" ISO that
// drives an unattended Ubuntu autoinstall, plus a self-contained SHA-512
// crypt implementation for autoinstall identity passwords (no openssl needed).
// dsh-esxi 种子 ISO 支持：生成驱动无人值守 Ubuntu autoinstall 的 cloud-init
// NoCloud "cidata" ISO，以及自包含的 SHA-512 crypt 实现（autoinstall 身份密码
// 无需依赖 openssl）。
import { createHash } from "node:crypto";

const SECTOR = 2048;
const CRYPT_ALPHABET = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ─────────────────────────────────────────────────────────────────────────────
// SHA-512 crypt (glibc sha512crypt, default 5000 rounds)
// ─────────────────────────────────────────────────────────────────────────────
const sha512 = (parts) => createHash("sha512").update(Buffer.concat(parts)).digest();

function cryptBits(digest) {
	// glibc's __b64_from_24bit permutation for SHA-512: 21 triples in this
	// exact byte order (4 chars each, low 6 bits first), then 2 chars from
	// alt_result[63].
	const triples = [
		[0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26],
		[6, 27, 48], [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32],
		[12, 33, 54], [34, 55, 13], [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38],
		[18, 39, 60], [40, 61, 19], [62, 20, 41]
	];
	let output = "";
	for (const [b2, b1, b0] of triples) {
		let w = (digest[b2] << 16) | (digest[b1] << 8) | digest[b0];
		output += CRYPT_ALPHABET[w & 0x3f];
		w >>= 6;
		output += CRYPT_ALPHABET[w & 0x3f];
		w >>= 6;
		output += CRYPT_ALPHABET[w & 0x3f];
		w >>= 6;
		output += CRYPT_ALPHABET[w & 0x3f];
	}
	let w = digest[63];
	output += CRYPT_ALPHABET[w & 0x3f];
	w >>= 6;
	output += CRYPT_ALPHABET[w & 0x3f];
	return output;
}

/** crypt(3) SHA-512 password hash in the `$6$salt$hash` form subiquity expects.
*  Ported exactly from glibc's sha512-crypt.c (rounds default 5000). */
export function sha512crypt(password, salt, rounds = 5000) {
	const key = Buffer.from(password, "utf8");
	const sl = Buffer.from(salt.slice(0, 16), "utf8");
	const keyLen = key.length;
	const saltLen = sl.length;
	const h = (...parts) => createHash("sha512").update(Buffer.concat(parts)).digest();

	// ctx = SHA512(key + salt), then alt_result repeated to key_len bytes.
	let altResult = h(key, sl, key);
	const ctxParts = [key, sl];
	for (let cnt = keyLen; cnt > 64; cnt -= 64) ctxParts.push(altResult);
	ctxParts.push(altResult.subarray(0, Math.min(keyLen, 64)));
	// Binary bits of key_len: set → alt_result, clear → key.
	for (let cnt = keyLen; cnt > 0; cnt >>= 1) ctxParts.push(cnt & 1 ? altResult : key);
	altResult = h(...ctxParts);

	// P sequence: digest of the key repeated key_len times, truncated/repeated to key_len bytes.
	const pSource = h(...Array.from({ length: Math.max(keyLen, 1) }, () => key));
	const pBytes = Buffer.alloc(keyLen);
	for (let offset = 0; offset < keyLen; offset += 1) pBytes[offset] = pSource[offset % 64];
	// S sequence: digest of the salt repeated (16 + alt_result[0]) times, to salt_len bytes.
	const sSource = h(...Array.from({ length: 16 + altResult[0] }, () => sl));
	const sBytes = Buffer.alloc(saltLen);
	for (let offset = 0; offset < saltLen; offset += 1) sBytes[offset] = sSource[offset % 64];

	for (let cnt = 0; cnt < rounds; cnt += 1) {
		const parts = [];
		parts.push(cnt & 1 ? pBytes : altResult);
		if (cnt % 3) parts.push(sBytes);
		if (cnt % 7) parts.push(pBytes);
		parts.push(cnt & 1 ? altResult : pBytes);
		altResult = h(...parts);
	}
	return `$6$${sl.toString("utf8")}$${cryptBits(altResult)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ISO9660 image (single session) with one directory of small files —
// exactly what a cloud-init NoCloud seed needs.
// ─────────────────────────────────────────────────────────────────────────────
function writeBoth32(buffer, value, offset) {
	buffer.writeUInt32LE(value, offset);
	buffer.writeUInt32BE(value, offset + 4);
}
function writeBoth16(buffer, value, offset) {
	buffer.writeUInt16LE(value, offset);
	buffer.writeUInt16BE(value, offset + 2);
}
function writeIsoDate(buffer, offset) {
	// Fixed date: 2026-08-19T00:00:00Z (years since 1900 = 126).
	const values = [126, 8, 19, 0, 0, 0, 0];
	for (let index = 0; index < 7; index += 1) buffer[offset + index] = values[index];
}

/** One 34+ byte directory record (padded to even length). */
function directoryRecord(name, extent, size, flags) {
	const nameLength = Buffer.byteLength(name, "ascii");
	const recordLength = 33 + nameLength + (nameLength % 2 === 0 ? 1 : 0);
	const record = Buffer.alloc(recordLength);
	record[0] = recordLength;
	writeBoth32(record, extent, 2);
	writeBoth32(record, size, 10);
	writeIsoDate(record, 18);
	record[25] = flags;
	writeBoth16(record, 1, 28);
	record[32] = nameLength;
	record.write(name, 33, "ascii");
	return record;
}

/** One 10-byte path-table record. */
function pathTableRecord(name, extent, parent) {
	const record = Buffer.alloc(10 + name.length + (name.length % 2 === 0 ? 1 : 0));
	record[0] = name.length + 1;
	writeBoth32(record, extent, 2);
	writeBoth16(record, parent, 6);
	record.write(name, 8, "ascii");
	return record;
}

/**
* Build a NoCloud seed ISO.
* @param files - name → content; `user-data` and `meta-data` are the usual pair.
* @param label - ISO9660 volume id (cloud-init mounts the "cidata" label).
* @returns the complete ISO image buffer (sector-aligned).
*/
export function buildSeedIso(files, label = "cidata") {
	const entries = Object.entries(files);
	// Layout: 16 system sectors; PVD (16), terminator (17), path tables L/M
	// (18/19), root directory (20); every file then gets its own extent sector
	// (21, 22, …) so directory records stay strictly standard.
	const pathTableSize = pathTableRecord("\0", 20, 1).length * 2;
	const records = [directoryRecord("\0", 20, 0, 0x02), directoryRecord("\x01", 20, 0, 0x02)];
	const fileSectors = [];
	let extent = 21;
	for (const [name, content] of entries) {
		const buffer = Buffer.from(content, "utf8");
		records.push(directoryRecord(name, extent, buffer.length, 0x00));
		const padded = Buffer.alloc(Math.ceil(buffer.length / SECTOR) * SECTOR);
		buffer.copy(padded);
		fileSectors.push(padded);
		extent += padded.length / SECTOR;
	}
	const directorySector = Buffer.alloc(SECTOR);
	let cursor = 0;
	for (const record of records) {
		record.copy(directorySector, cursor);
		cursor += record.length;
	}
	const volumeSpace = 21 + fileSectors.length;
	const image = Buffer.alloc(volumeSpace * SECTOR);

	// Primary Volume Descriptor (sector 16).
	const pvd = Buffer.alloc(SECTOR);
	pvd[0] = 1;
	pvd.write("CD001", 1, "ascii");
	pvd[6] = 1;
	pvd.write("                                   ".slice(0, 32), 8, "ascii"); // system id
	pvd.write(label.padEnd(32, " ").slice(0, 32), 40, "ascii"); // volume id
	writeBoth32(pvd, volumeSpace, 80);
	writeBoth16(pvd, 1, 120); // volume set size
	writeBoth16(pvd, 1, 124); // volume sequence number
	writeBoth16(pvd, SECTOR, 128); // logical block size
	writeBoth32(pvd, pathTableSize, 132);
	writeBoth32(pvd, 18, 140); // L path table
	writeBoth32(pvd, 0, 144); // optional L
	writeBoth32(pvd, 19, 148); // M path table
	writeBoth32(pvd, 0, 152); // optional M
	directoryRecord("\0", 20, SECTOR, 0x02).copy(pvd, 156);
	pvd.write("cidata".padEnd(128, " ").slice(0, 128), 190, "ascii"); // volume set id
	pvd.write("dsh-esxi".padEnd(128, " ").slice(0, 128), 318, "ascii"); // publisher
	pvd.write("dsh-esxi".padEnd(128, " ").slice(0, 128), 446, "ascii"); // preparer
	pvd.write("dsh-esxi".padEnd(128, " ").slice(0, 128), 574, "ascii"); // application
	pvd.write("autoinstall seed".padEnd(37, " ").slice(0, 37), 702, "ascii"); // copyright
	pvd.write("".padEnd(37, " "), 739, "ascii"); // abstract
	pvd.write("".padEnd(37, " "), 776, "ascii"); // bibliographic
	writeIsoDate(pvd, 813); // creation
	writeIsoDate(pvd, 830); // modification
	writeIsoDate(pvd, 847); // expiration
	writeIsoDate(pvd, 864); // effective
	pvd[881] = 1; // file structure version
	image.set(pvd, 16 * SECTOR);

	// Volume Descriptor Set Terminator (sector 17).
	const terminator = Buffer.alloc(SECTOR);
	terminator[0] = 255;
	terminator.write("CD001", 1, "ascii");
	terminator[6] = 1;
	image.set(terminator, 17 * SECTOR);

	// Path tables (sectors 18, 19).
	const pathL = Buffer.alloc(SECTOR);
	const pathM = Buffer.alloc(SECTOR);
	pathTableRecord("\0", 20, 1).copy(pathL, 0);
	pathTableRecord("\0", 20, 1).copy(pathM, 0);
	image.set(pathL, 18 * SECTOR);
	image.set(pathM, 19 * SECTOR);

	// Root directory (sector 20) and file data sectors.
	image.set(directorySector, 20 * SECTOR);
	fileSectors.forEach((sector, index) => image.set(sector, (21 + index) * SECTOR));
	return image;
}

/** Serialize an Ubuntu autoinstall user-data document (with a crypted password). */
export function autoinstallUserData({ hostname, username, password, sshPasswordAuth = true, packages = [], timezone = "UTC" }) {
	const lines = [
		"#cloud-config",
		"autoinstall:",
		"  version: 1",
		"  interactive-sections: []",
		"  locale: en_US.UTF-8",
		"  timezone: " + timezone,
		"  keyboard:",
		"    layout: us",
		"  identity:",
		`    hostname: ${hostname}`,
		`    username: ${username}`,
		`    password: "${sha512crypt(password, "dshseed")}"`,
		"  ssh:",
		"    install-server: true",
		`    allow-pw: ${sshPasswordAuth ? "true" : "false"}`,
		"  storage:",
		"    layout:",
		"      name: direct",
		"  apt:",
		"    geoip: false"
	];
	if (packages.length > 0) {
		lines.push("  packages:");
		for (const pkg of packages) lines.push(`    - ${pkg}`);
	}
	lines.push("");
	return lines.join("\n");
}

/** NoCloud meta-data for one instance. */
export function autoinstallMetaData(hostname) {
	return `instance-id: ${hostname}\nlocal-hostname: ${hostname}\n`;
}
