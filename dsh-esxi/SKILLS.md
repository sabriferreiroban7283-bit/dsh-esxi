# dsh-esxi — Skills & Tips (测试技巧与最佳实践)

Field-tested techniques distilled from live ESXi 8.0 lab work (host "200").
每一条都经过真实主机验证；直接照抄可用。

## Safety rules first (安全先行)

1. **Scratch VMs only**: name everything disposable `tst-*`, and never run test
   operations against existing production VMs. Check `esxi_vm_list` first.
2. **One login attempt per password**: a rejected stored password starts a
   15-minute fail-fast latch in the plugin (continued retries are what lock
   ESXi accounts — usually 5 failures). Fix the password via `esxi_connect`
   and wait out any lockout instead of retrying.
3. **Clean up after every test**: delete scratch VMs, snapshots, disks,
   roles, pools, and datastore folders — verify with `esxi_vm_list` /
   `esxi_pool_list` that the inventory returns to its previous state.

## Recipes (配方)

### One-click OS install (cloud image — the VPS/cloud-provider model)

```
esxi_vm_import { file: "<noble .ova>", name: "web-1", datastore: "datastore2" }
esxi_vm_network { vm: "web-1", operation: "change", device: "ethernet-0", network: "VM Network", mac: "-" }
esxi_vm_cloudinit { vm: "web-1", userData: "#cloud-config\nhostname: web-1\nusers:\n  - name: ubuntu\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    lock_passwd: false\n    hashed_passwd: '$6$…'\nssh_pwauth: true" }
esxi_vm_power { vm: "web-1", operation: "on" }
```

- cloud-init 26.x ignores the legacy `passwd:` key — use `hashed_passwd:`.
- Usernames must not collide with pre-existing groups (`admin` is a GROUP in
  the cloud images — use `ubuntu`).

### One-call VM creation

```
esxi_vm_quick { name: "vm-1", cpu: 2, memory: 2048, disk: "20GB", datastore: "datastore2", network: "VM Network", iso: "iso/installer.iso", serial: true, powerOn: true }
```

Covers create + ISO (cdrom add/insert/connect + cdrom-first boot) + file
serial console + power-on. Omit `network` only when the host has exactly one.

### Headless boot capture (no credentials needed)

```
esxi_vm_serial { vm: "vm-1", operation: "add" }
esxi_vm_serial { vm: "vm-1", operation: "connect", uri: "-" }        # boot log → <vm>/serialport-9000.log
esxi_vm_serial { vm: "vm-1", operation: "connect", device: "serialport-9001", uri: "telnet://:33233" }  # interactive: nc <host> 33233
```

Then `esxi_datastore_download` the log. For telnet consoles enable the ESXi
`remoteSerialPort` firewall ruleset and prefer `nc` over `telnet` (IAC
negotiation can make the vmx drop the connection). Some guests stream boot
output only on ttyS0 — keep the file there and the telnet console on port 2.

### Snapshot revert chain

```
esxi_vm_snapshot { vm: "vm-1", operation: "create", name: "snap1", memory: false }
# change something (add a disk), then:
esxi_vm_snapshot { vm: "vm-1", operation: "revert", name: "snap1" }
```

### Clone replacement on license-limited hosts

Standalone hosts without the CloneVM right reject `esxi_vm_clone`
("not supported on the object" — the plugin translates it). Use:

```
esxi_vm_export { vm: "src", destination: "./ovf-out" }
esxi_vm_import { file: "./ovf-out/src/src.ovf", name: "copy", datastore: "datastore2" }
```

## Field notes (现场笔记)

- **govc binary loss**: the harness host occasionally loses the installed
  govc; `runGovc` re-installs it on the first ENOENT and retries with the
  installed path. Permanent fix: set `govcPath` in the plugin settings to an
  absolute path (e.g. `/home/<user>/.dsh/esxi/bin/govc`).
- **Datastore defaults**: `esxi_vm_disk create` / `esxi_vm_clone` default to
  the VM's own datastore — govc's "default datastore resolves to multiple
  instances" never blocks you again.
- **Pool paths**: hosts inside dot-named folders (`localhost.`) break
  absolute pool paths — use the glob form `*/Resources/<pool>` everywhere.
- **Stream-optimized disks** (OVA imports) cannot be grown in place — the
  host rejects `vm.disk.change`; attach a second larger disk instead.
- **Standalone-host limits**: tags (vCenter-only REST API) and recent-task
  history (`esxi_task_list`) are unavailable — `esxi_event_list` covers the
  same lifecycle events. Cloning/templates may also be license-disabled.
- **root permission guard**: standalone ESXi refuses changes that could
  reduce root's Admin rights — grant limited roles to NON-root principals.
- **MAC assignment**: OVA imports can leave a NIC MAC empty (DHCP then
  fails); assign one with `esxi_vm_network` and avoid VMware OUIs
  (`00:0c:29`, `00:50:56`).
- **CD-ROM media**: always `connect` after inserting — disconnected media is
  invisible to the guest (the plugin connects automatically).
- **Guest NIC enumeration** may differ from vSphere device numbering (e1000
  can enumerate last) — map interfaces by MAC, not by name.
