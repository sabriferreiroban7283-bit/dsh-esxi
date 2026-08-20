// dsh-esxi VMDK support: converts a VMware monolithicSparse (Workstation)
// single-file VMDK into the descriptor + raw flat layout ESXi can run
// directly (monolithicFlat), plus a tiny descriptor writer. No qemu-img
// needed — the sparse format is a grain directory + grain tables.
// dsh-esxi VMDK 支持：把 VMware 工作站格式的单文件 monolithicSparse VMDK
// 转成 ESXi 可直接运行的「描述符 + 原始 flat」布局（monolithicFlat），
// 并提供描述符生成函数。全程无需 qemu-img——sparse 格式即颗粒目录 + 颗粒表。

const SECTOR = 512;
const GRAIN_SECTORS = 128; // sparse extent grain = 64 KiB
const GRAIN_BYTES = GRAIN_SECTORS * SECTOR;
const GTES_PER_GT = 4096;
const UNALLOCATED = 0xffffffff;

/** Parse the sparse extent header (512 bytes at offset 0). */
export function parseSparseHeader(buf) {
	if (buf.subarray(0, 4).toString("latin1") !== "KDMV") throw new Error("not a sparse VMDK (missing KDMV magic)");
	return {
		version: buf.readUInt32LE(4),
		flags: buf.readUInt32LE(8),
		capacitySectors: Number(buf.readBigUInt64LE(12)),
		grainSectors: Number(buf.readBigUInt64LE(20)),
		descriptorOffsetSectors: Number(buf.readBigUInt64LE(28)),
		descriptorSizeSectors: Number(buf.readBigUInt64LE(36)),
		numGTEsPerGT: buf.readUInt32LE(44),
		rgdOffsetSectors: Number(buf.readBigUInt64LE(48)),
		gdOffsetSectors: Number(buf.readBigUInt64LE(56)),
		overheadSectors: Number(buf.readBigUInt64LE(64))
	};
}

/** Build the VMDK descriptor text for a raw flat extent. */
export function flatDescriptor({ fileName, capacitySectors, adapterType = "lsilogic", hwVersion = "13", heads = 16, sectors = 63 }) {
	const cylinders = Math.max(1, Math.ceil(capacitySectors / (heads * sectors)));
	return [
		"# Disk DescriptorFile",
		"version=1",
		"CID=fffffffe",
		"parentCID=ffffffff",
		'createType="monolithicFlat"',
		"",
		`RW ${capacitySectors} FLAT "${fileName}" 0`,
		"",
		"# The Disk Data Base",
		"#DDB",
		`ddb.adapterType = "${adapterType}"`,
		`ddb.virtualHWVersion = "${hwVersion}"`,
		`ddb.geometry.cylinders = "${cylinders}"`,
		`ddb.geometry.heads = "${heads}"`,
		`ddb.geometry.sectors = "${sectors}"`,
		""
	].join("\n");
}

/**
 * Convert a monolithicSparse VMDK file into a raw image Buffer.
 * Returns the raw bytes; caller decides where to write them.
 */
export function sparseVmdkToRaw(sparseBuf) {
	const header = parseSparseHeader(sparseBuf.subarray(0, SECTOR));
	if (header.grainSectors !== GRAIN_SECTORS) {
		throw new Error(`unsupported grain size ${header.grainSectors} (expected ${GRAIN_SECTORS})`);
	}
	const capacity = header.capacitySectors * SECTOR;
	const totalGrains = Math.ceil(header.capacitySectors / GRAIN_SECTORS);
	const totalGTs = Math.ceil(totalGrains / header.numGTEsPerGT);

	// Grain directory: one uint32 per grain table.
	const gdOffset = header.gdOffsetSectors * SECTOR;
	const gd = [];
	for (let i = 0; i < totalGTs; i++) {
		gd.push(sparseBuf.readUInt32LE(gdOffset + i * 4));
	}

	const out = Buffer.alloc(capacity, 0);
	for (let grain = 0; grain < totalGrains; grain++) {
		const gdIndex = Math.floor(grain / header.numGTEsPerGT);
		const gteIndex = grain % header.numGTEsPerGT;
		const gtOffsetSectors = gd[gdIndex];
		if (gtOffsetSectors === UNALLOCATED) continue; // whole GT empty → grain stays zero
		const gtOffset = gtOffsetSectors * SECTOR;
		const grainStart = sparseBuf.readUInt32LE(gtOffset + gteIndex * 4);
		if (grainStart === UNALLOCATED) continue; // grain stays zero
		const src = grainStart * SECTOR;
		const dst = grain * GRAIN_BYTES;
		if (dst + GRAIN_BYTES > capacity) {
			sparseBuf.copy(out, dst, src, src + (capacity - dst));
		} else {
			sparseBuf.copy(out, dst, src, src + GRAIN_BYTES);
		}
	}
	return out;
}
