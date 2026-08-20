# dsh-esxi

English | [中文](README.zh.md)

DSH plugin for **ESXi / vCenter (vSphere) operations**. It covers the full
day-2 administration surface of vSphere estates — vCenter Server, standalone
ESXi hosts, clusters, and the surrounding ecosystem (vSAN, content library,
tags, permissions, licensing, tasks/events/alarms) — through a family of
`esxi_*` tools backed by VMware's official
[govc](https://github.com/vmware/govmomi) CLI.

```
dsh plugin --profile web add dsh-esxi
```

One command installs and mounts the plugin (the package declares
`dsh.bundle.patch`, so the profile bundle stack is updated automatically).

## How it works

- **Connection profiles** — `esxi_connect` stores vCenter/ESXi endpoints (URL,
  username, datacenter, folder, TLS mode) in `<dsh home>/esxi/profiles.json`.
  Passwords go through the harness **credentials store**
  (`$DSH_HOME/.credentials.yaml`), never into the profiles file.
- **govc runner** — every tool shells out to `govc` with the profile's
  `GOVC_*` environment. Args are passed as `argv` via `execFile` — **no shell
  is ever involved** — with per-tool timeouts and output truncation.
- **Approval gate** — destructive operations (VM delete/power-off, host
  maintenance/reboot, datastore delete, permission changes, esxcli, raw
  `esxi_run` against destructive subcommands, …) ask the user through the
  harness approval seam before executing.
- **Settings panel** — a dedicated configuration card under
  **Settings → "ESXi / vCenter"** — a direct entry in the Settings
  sidebar (registered through the `dsh-esxi` settings namespace and the
  `settings.section` slot, like `dsh-better-sidebar`'s own section) edits the govc
  binary, timeouts, output caps, the approval toggle, and connection profiles
  (ESXi host details). Values live in `$DSH_HOME/settings.yaml` (mode 0600),
  are re-applied live, and settings-managed profiles override same-named
  `esxi_connect` profiles.
- **Self-contained** — the package imports only Node builtins at runtime
  (plus a lazily-imported, optional `@deepseek-ai/schemastery` for the settings
  surface), so it loads from any install location (registry, tarball, or a
  local `file:` link) and degrades gracefully when the settings surface cannot
  resolve.

## Requirements

- `govc` on `PATH` (or a custom path via plugin config `govcPath`). If it is
  missing, `esxi_doctor {install: true}` downloads the official release binary
  into `<dsh home>/esxi/bin`.
- Network reachability from the dsh host to the vCenter/ESXi management
  interface (port 443).
- For guest operations (`esxi_guest_*`): VMware Tools running in the guest.
- For the settings panel: the **web** profile (browser UI). The section
  appears directly in the Settings sidebar as "ESXi / vCenter".
- Node >= 20.

## Install & configure

```sh
# install into the web profile (also works for headless or custom profiles)
dsh plugin --profile web add dsh-esxi
```

Configuration lives on the plugin row; override it from the profile's
`cordis.patch.yml`:

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: esxi
  config:
    govcPath: /opt/govc/bin/govc        # binary name or absolute path (default "govc")
    installDir: ~/.dsh/esxi/bin         # where esxi_doctor installs govc
    profilesFile: ~/.dsh/esxi/profiles.json
    defaultTimeoutMs: 120000            # ordinary command timeout
    longTimeoutMs: 600000               # export/upload/clone/migrate timeout
    maxOutputChars: 30000               # model-visible output cap
    infoCap: 100                        # batch enrichment cap for vm/host lists
    inventoryMaxItems: 100              # names per type in esxi_inventory
    approveDestructive: true            # approval gate master switch
```

## Quick start

1. `esxi_doctor` — verifies the govc binary (add `install: true` to fetch it).
2. `esxi_connect` — add a profile:
   ```
   esxi_connect { profile: "prod", url: "vc01.example.com", username: "administrator@vsphere.local", password: "...", datacenter: "DC1" }
   ```
3. `esxi_about` — confirm connectivity and version.
4. `esxi_inventory` — map the environment (counts per object type).
5. `esxi_vm_list {details: true}` — see the VMs with power state and IPs.
6. `esxi_vm_power {vm: "web-01", operation: "off"}` — approve the destructive
   prompt, then observe the task result.

Standalone ESXi works the same way: point a profile at the host directly
(`url: "esxi-host", username: "root", insecure: true`).

Without any profile, tools fall back to the environment when `GOVC_URL`,
`GOVC_USERNAME`, `GOVC_PASSWORD` (and friends) are exported. An explicit
`profile` argument on any tool overrides the default for that one call.

## Settings panel (web UI)

The plugin ships a dedicated configuration interface in the DSH settings:
**Settings → "ESXi / vCenter"** — a direct entry in the Settings sidebar,
opened with one click. It is a native `settings.section` bound to the
`dsh-esxi` settings namespace
(`settings.yaml`, mode 0600), the same pattern the built-in plugin cards use.

What it edits:

| Group | Fields |
|---|---|
| govc runtime | `govcPath`, `installDir`, `profilesFile` |
| Timeouts & output | `defaultTimeoutMs`, `longTimeoutMs`, `maxOutputBytes`, `maxOutputChars`, `infoCap`, `inventoryMaxItems` |
| Safety | `approveDestructive` (live — no restart needed) |
| Connection profiles (ESXi host details) | per profile: `name`, `url`, `username`, `password` (secret), `insecure`, `datacenter`, `folder`, `tlsCaCerts`; add / remove rows |

Behavior and guarantees:

- Edits are **staged**: fields show the resolved value and an "overridden"
  badge; Save writes only the changed fields (revision-fenced), Discard reverts,
  and per-field Reset returns to the schema default.
- Values take effect **immediately** (the host re-applies the namespace on
  every change) — including the approval toggle and profile additions.
- Settings-managed profiles are marked `(settings)` in `esxi_profiles`,
  override same-named `esxi_connect` profiles, and are **never persisted to
  `profiles.json`** (they live only in the settings document).
- Passwords are declared `role("secret")` in the namespace schema, so the
  settings wire redacts them (`settings.describe({ redactSecrets: true })`);
  they are stored in `settings.yaml` (0600) and never echoed after saving.
- **Remote browsers** — the native settings RPC is loopback-only, so a GUI
  served through `--trusted-host` authorities would see "unavailable". The
  card transparently falls back to the plugin's own `/esxi/settings.get` and
  `/esxi/settings.save` JSON routes, guarded host-side by the same
  browser-trust fence as the API gateway (Host-header loopback or the web
  runtime's trusted hosts, plus same-origin markers).
- Degradation: if `@deepseek-ai/schemastery` cannot be resolved (unusual
  install locations), the tools keep working and only the settings surface is
  skipped. For a local `file:` link install, run
  `npm install --no-save @deepseek-ai/schemastery` inside the package
  directory so the surface activates.

### Manual settings (headless / CI)

The same namespace can be edited directly in the settings document — useful
for headless profiles and automation, where no browser panel exists:

```yaml
# $DSH_HOME/settings.yaml
dsh-esxi:
  govcPath: /opt/govc/bin/govc
  defaultTimeoutMs: 120000
  longTimeoutMs: 600000
  maxOutputBytes: 67108864
  maxOutputChars: 30000
  infoCap: 100
  inventoryMaxItems: 100
  approveDestructive: true
  profiles:
    - name: prod
      url: vc01.example.com          # normalized to https://vc01.example.com/sdk
      username: administrator@vsphere.local
      password: "..."                # secret — redacted from the settings wire
      insecure: true
      datacenter: DC1
```

The plugin hot-reloads this document (`scope.watch`), so edits apply without a
restart; settings-managed profiles stay out of `profiles.json`.

## Examples

**One-click OS provisioning (cloud image + cloud-init — the VPS/cloud-provider model):**

This is the recommended way to create a VM with an OS installed, fully
automatic — there is no installer and no interactive screen at all. Download an
official Ubuntu cloud image OVA (open-vm-tools included) once, then:

```
# 1. import the official cloud image (local file streams through the SDK)
esxi_vm_import { file: "/data/noble-server-cloudimg-amd64.ova", name: "ubuntu-2404", datastore: "datastore2" }
# 2. grow the disk, size the VM, and inject the cloud-init seed BEFORE first power-on
esxi_vm_disk { vm: "ubuntu-2404", operation: "resize", name: "disk-1000-0", size: "100GB" }
esxi_vm_change { vm: "ubuntu-2404", cpu: 4, memory: 8192 }
esxi_vm_cloudinit { vm: "ubuntu-2404", userData: "#cloud-config\nhostname: ubuntu-2404\nusers:\n  - name: ubuntu\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    lock_passwd: false\n    hashed_passwd: '$6$...'  # sha512crypt hash — the legacy passwd: key is silently ignored by cloud-init 26.x\nssh_pwauth: true" }
# 3. boot — cloud-init provisions hostname/users/SSH and grows the filesystem
esxi_vm_power { vm: "ubuntu-2404", operation: "on" }
```

Verified end-to-end on ESXi 8.0 with `noble-server-cloudimg-amd64.ova`:
boot → cloud-init (`DataSourceVMware [seed=guestinfo]`) → `status: done`,
`lsblk` shows `sda1 99G /`, login works with the seeded user. Use a username
that does not collide with a pre-existing group (the image ships an `admin`
group, so `useradd admin` fails — `ubuntu` is the conventional choice).

Mechanics: `esxi_vm_cloudinit` writes `guestinfo.userdata` / `guestinfo.metadata`
(base64) into the VM's ExtraConfig; the image's cloud-init `DataSourceVMware`
reads them through VMware Tools on first boot (no OVF environment file is
created by `import.ova`, so the guestinfo transport is the one that applies).
Field notes from real deployments:

- **Set the NIC MAC explicitly.** `import.ova` can leave the MAC empty, and
  DHCP silently fails on an empty-MAC NIC:
  `esxi_vm_network { vm: "…", operation: "change", device: "ethernet-0", network: "VM Network", mac: "-" }`
  (manual MACs must not use VMware-reserved OUIs like `00:0c:29`).
- **CD-ROM media must be connected** (`esxi_vm_iso` now connects it for you);
  a disconnected CD-ROM is invisible to the guest.
- **A datastore path upload into a file a running VM's CD-ROM holds is
  rejected** (500): power the VM off first.
- **`systemd-networkd-wait-online` blocks boot for ~2 min on portgroups
  without DHCP**; provisioning still completes afterwards. To skip the wait,
  add `network: {config: disabled}` to the user-data (check the cloud-init
  version first — some 26.x builds reject that key under schema validation).
- **Watch a boot without credentials:** `esxi_vm_serial { operation: "add" }`
  then `esxi_vm_serial { operation: "connect", uri: "-" }` captures the
  kernel/cloud-init console to `<vm>/serialport-9000.log` on the datastore;
  `uri: "telnet://:33233"` (plus the ESXi `remoteSerialPort` firewall ruleset,
  `esxi_host_esxcli { args: "network firewall ruleset set --enabled true --ruleset-id remoteSerialPort" }`)
  gives an interactive login console — connect with `nc <host> 33233`
  (telnet's IAC negotiation can make the vmx drop the connection).

**Unattended Ubuntu autoinstall from the server ISO (end to end):**

For 24.04+ this additionally requires booting the installer with the
`autoinstall` kernel argument (subiquity only enters autoinstall mode then) —
use a GRUB-modified ISO, or the cloud-image flow above which needs no ISO at
all:

```
esxi_vm_create { name: "ubuntu-2404", cpu: 4, memory: 8192, disk: "100GB", datastore: "datastore2", guestId: "ubuntu64Guest", firmware: "efi", network: "VM Network", powerOn: false }
esxi_seed_iso { name: "ubuntu-2404-seed", hostname: "ubuntu-2404", username: "admin", password: "changeme", datastore: "datastore2", packages: "open-vm-tools" }
esxi_vm_iso { vm: "ubuntu-2404", operation: "add" }                                  # first CD-ROM
esxi_vm_iso { vm: "ubuntu-2404", operation: "insert", datastore: "datastore1", iso: "iso/ubuntu-24.04.4-live-server-amd64.iso" }
esxi_vm_iso { vm: "ubuntu-2404", operation: "add" }                                  # second CD-ROM
esxi_vm_iso { vm: "ubuntu-2404", operation: "insert", datastore: "datastore2", iso: "iso/ubuntu-2404-seed.iso" }
esxi_vm_boot { vm: "ubuntu-2404", order: "cdrom,disk" }
esxi_vm_power { vm: "ubuntu-2404", operation: "on" }                                 # installs unattended
# afterwards: restore disk boot and drop the seed ISO
esxi_vm_boot { vm: "ubuntu-2404", order: "disk" }
esxi_datastore_delete { datastore: "datastore2", path: "iso/ubuntu-2404-seed.iso" }
```

The seed ISO carries a cloud-init NoCloud `cidata` volume with an `autoinstall`
user-data (identity with a SHA-512 crypt password, direct disk layout, SSH,
extra packages) — only the hash ever lands on the datastore.

**Clone a VM from a template, then snapshot it:**

```
esxi_vm_clone { vm: "tpl-web", name: "web-02", datastore: "datastore1", pool: "/DC1/host/Cluster1/Resources/web" }
esxi_vm_snapshot { vm: "web-02", operation: "create", name: "baseline", memory: false }
```

**Grow a disk and add a NIC:**

```
esxi_vm_disk   { vm: "db-01", operation: "resize", name: "db-01/db-01.vmdk", size: "200GB" }
esxi_vm_network { vm: "db-01", operation: "add", network: "VM Network", adapter: "vmxnet3" }
```

**Host maintenance and esxcli:**

```
esxi_host_maintenance { host: "esxi-02", mode: "enter", evacuate: true }
esxi_host_esxcli      { host: "esxi-02", args: "storage vmfs list" }
esxi_host_esxcli      { host: "esxi-02", args: "network ip route ipv4 list" }
```

**Datastore round-trip:**

```
esxi_datastore_upload   { datastore: "datastore1", localPath: "config.iso", remotePath: "web-02/config.iso" }
esxi_datastore_download { datastore: "datastore1", remotePath: "web-02/vmware.log", localPath: "vmware.log" }
```

**Anything not covered by a dedicated tool:**

```
esxi_run { args: "vsan.info ClusterA" }
esxi_run { args: "option.set log.level info" }
esxi_run { args: "collect /DC1/vm/db-01 runtime.powerState" }
```

## Tool reference

| Area | Tools |
|---|---|
| Profiles & env | `esxi_connect`, `esxi_disconnect`, `esxi_profiles`, `esxi_set_default`, `esxi_about`, `esxi_doctor` |
| Inventory | `esxi_inventory`, `esxi_find`, `esxi_collect`, `esxi_tree` |
| VMs | `esxi_vm_list`, `esxi_vm_info`, `esxi_vm_power`, `esxi_vm_create` (incl. `iso`/`isoDatastore`), `esxi_vm_import` (OVA/OVF), `esxi_vm_cloudinit` (guestinfo seed), `esxi_vm_iso`, `esxi_vm_boot`, `esxi_vm_serial` (console capture/telnet), `esxi_seed_iso`, `esxi_vm_clone`, `esxi_vm_change`, `esxi_vm_disk`, `esxi_vm_network`, `esxi_vm_snapshot`, `esxi_vm_migrate`, `esxi_vm_export`, `esxi_vm_template`, `esxi_vm_register`, `esxi_vm_unregister`, `esxi_vm_delete` |
| Guest ops | `esxi_guest_exec`, `esxi_guest_file` |
| Datastores | `esxi_datastore_list`, `esxi_datastore_browse`, `esxi_datastore_upload`, `esxi_datastore_download`, `esxi_datastore_copy`, `esxi_datastore_delete`, `esxi_datastore_create` |
| Networking | `esxi_network_list`, `esxi_portgroup_add`, `esxi_portgroup_remove`, `esxi_vswitch_list`, `esxi_vswitch_add`, `esxi_vswitch_remove` |
| Hosts | `esxi_host_list`, `esxi_host_info`, `esxi_host_maintenance`, `esxi_host_power`, `esxi_host_esxcli`, `esxi_host_add`, `esxi_host_remove`, `esxi_host_reconnect`, `esxi_host_service`, `esxi_host_option` |
| Clusters & pools | `esxi_cluster_create`, `esxi_cluster_info`, `esxi_cluster_change`, `esxi_pool_list`, `esxi_pool_create`, `esxi_pool_change`, `esxi_pool_destroy` |
| Admin | `esxi_tag_list`, `esxi_tag_create`, `esxi_tag_attach`, `esxi_permission_list`, `esxi_permission_set`, `esxi_permission_remove`, `esxi_role_list`, `esxi_role_create`, `esxi_license_list`, `esxi_license_add`, `esxi_license_assign`, `esxi_task_list`, `esxi_event_list`, `esxi_alarm_list`, `esxi_library_list`, `esxi_library_deploy`, `esxi_datacenter_create` |
| Raw | `esxi_run` — arbitrary govc command (e.g. `vsan.info ClusterA`, `import.ova`, `cluster.rule.*`, `alarm.info`, `option.set`) |

### Notable details

- **Names/paths**: every object parameter accepts a name or an inventory path
  (`/DC1/vm/MyVM`). When a datacenter is set on the profile, short names
  resolve relative to it.
- **`esxi_run`** parses the command line safely (quotes/escapes honored) and
  passes argv directly to govc — never a shell. The first token must be a govc
  subcommand. A curated list of destructive subcommand prefixes triggers the
  approval gate.
- **`esxi_host_esxcli`** covers the long tail of host administration
  (storage, network, software, services, system, hardware) through `govc
  host.esxcli`. All esxcli invocations are gated.
- **`esxi_vm_disk` detach** keeps the disk files on the datastore
  (`device.remove -keep`); deleting the files afterwards is a separate
  `esxi_datastore_delete` decision.
- **`esxi_vm_export`** writes an OVF directory; `ova: true` bundles it with
  `tar`.
- **vSAN / content library / alarms / advanced options** are reachable through
  `esxi_run` (`govc vsan.info`, `govc library.*`, `govc alarms`, `govc
  option.set`) — the dedicated tool set above covers the most common
  operations with structured parameters.

## Security notes

- Passwords are stored through the harness credentials store
  (`$DSH_HOME/.credentials.yaml`, mode 0600) under refs like
  `ESXI_PASSWORD_PROD`; the profiles file holds no secrets.
- Destructive operations fail closed: with no approval channel (or an
  unattended session), the call is rejected rather than executed.
- `esxi_connect` offers `insecure: true` (default) for self-signed vCenter
  certificates; for production, point `tlsCaCerts` at your CA bundle instead.
- Guest-operation passwords are passed on the command line to govc (visible
  in the process table of the dsh host for the duration of the call).
- Settings-panel passwords live in `$DSH_HOME/settings.yaml` (mode 0600), are
  declared `role("secret")` in the namespace schema (redacted from the
  settings wire), and are only held in memory by the plugin afterwards.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `govc: command not found` / `govc not runnable` | govc is not installed. Run `esxi_doctor {install: true}` to download the official binary, or set plugin config `govcPath` to an existing binary. |
| `x509: certificate signed by unknown authority` | TLS verification fails on a self-signed vCenter. Reconnect with `insecure: true`, or set `tlsCaCerts` to your CA bundle. |
| `ServerFaultCode: Permission to perform this operation was denied` | The profile account lacks the required privilege. Check the principal's role with `esxi_permission_list` and grant with `esxi_permission_set`. |
| `Cannot complete login due to an incorrect user name or password` | Wrong credentials, or the account is locked/disabled. Use `administrator@vsphere.local` for vCenter SSO; `root` for standalone hosts. |
| `[timed out after …]` | The operation exceeded `defaultTimeoutMs`. Raise it in the plugin config, use `esxi_run {timeoutMs: …}`, or narrow the scope (e.g. `esxi_find` instead of `esxi_inventory`). |
| `unknown command: …` from `esxi_run` | The subcommand does not exist in your govc version. Run `esxi_run {args: "version"}` and check the [govc docs](https://github.com/vmware/govmomi/blob/main/govc/USAGE.md). |
| govc auto-install unsupported on this platform | `esxi_doctor` auto-install covers linux/darwin amd64+arm64 (and Windows legacy). Otherwise download the binary manually from the [releases page](https://github.com/vmware/govmomi/releases). |
| Guest ops fail with `GuestOperationsUnavailable` | VMware Tools is not running (or too old) in the guest; install/upgrade Tools first (`esxi_run {args: "vm.guest.tools -upgrade <vm>"}`). |

## govc command mapping (appendix)

Every tool wraps one govc subcommand (the `esxi_run` tool is the general
escape hatch). The mapping below is a quick lookup; tool parameter docs remain
authoritative.

| Tool | govc command |
|---|---|
| `esxi_about` | `govc about` |
| `esxi_inventory` / `esxi_find` / `esxi_tree` / `esxi_collect` | `govc find`, `govc ls`, `govc tree`, `govc collect` |
| `esxi_vm_list` / `esxi_vm_info` | `govc find -type m`, `govc vm.info` |
| `esxi_vm_power` | `govc vm.power` |
| `esxi_vm_create` / `esxi_vm_clone` | `govc vm.create` / `govc vm.clone` |
| `esxi_vm_change` | `govc vm.change` |
| `esxi_vm_disk` | `govc vm.disk.create` / `vm.disk.attach` / `vm.disk.change` / `device.remove -keep` |
| `esxi_vm_network` | `govc vm.network.add` / `vm.network.change` / `device.remove` |
| `esxi_vm_snapshot` | `govc snapshot.create` / `snapshot.tree` / `snapshot.revert` / `snapshot.remove` |
| `esxi_vm_migrate` | `govc vm.migrate` |
| `esxi_vm_export` | `govc export.ovf` |
| `esxi_vm_template` | `govc vm.markastemplate` / `vm.markasvm` |
| `esxi_vm_register` / `esxi_vm_unregister` / `esxi_vm_delete` | `govc vm.register` / `vm.unregister` / `vm.destroy` |
| `esxi_guest_exec` / `esxi_guest_file` | `govc guest.start` / `guest.ps` / `guest.kill` / `guest.upload` / `guest.download` / `guest.ls` / `guest.mkdir` / `guest.rm` |
| `esxi_datastore_list` / `esxi_datastore_browse` | `govc datastore.info` / `datastore.ls` |
| `esxi_datastore_upload` / `esxi_datastore_download` | `govc datastore.upload` / `datastore.download` |
| `esxi_datastore_copy` / `esxi_datastore_delete` | `govc datastore.cp` / `datastore.mv` / `datastore.rm` |
| `esxi_datastore_create` | `govc datastore.mkdir` / `datastore.create` |
| `esxi_network_list` / `esxi_portgroup_add` / `esxi_portgroup_remove` | `govc find -type n,g` / `host.portgroup.add` / `host.portgroup.remove` / `dvs.portgroup.add` / `object.destroy` |
| `esxi_vswitch_list` / `esxi_vswitch_add` / `esxi_vswitch_remove` | `govc host.vswitch.info` / `host.vswitch.add` / `host.vswitch.remove` |
| `esxi_host_list` / `esxi_host_info` | `govc find -type h`, `govc host.info` |
| `esxi_host_maintenance` | `govc host.maintenance.enter` / `host.maintenance.exit` |
| `esxi_host_power` | `govc host.shutdown -r` / `host.shutdown -f` |
| `esxi_host_esxcli` | `govc host.esxcli` |
| `esxi_host_add` | `govc cluster.add` / `host.add` |
| `esxi_host_remove` / `esxi_host_reconnect` | `govc host.remove` / `host.reconnect` |
| `esxi_host_service` / `esxi_host_option` | `govc host.service` / `host.option.ls` / `host.option.set` |
| `esxi_cluster_create` / `esxi_cluster_info` / `esxi_cluster_change` | `govc cluster.create` / `cluster.usage` / `cluster.change` |
| `esxi_pool_list` / `esxi_pool_create` / `esxi_pool_change` / `esxi_pool_destroy` | `govc pool.info` / `pool.create` / `pool.change` / `pool.destroy` |
| `esxi_tag_list` / `esxi_tag_create` / `esxi_tag_attach` | `govc tags.category.ls` / `tags.ls` / `tags.category.create` / `tags.create` / `tags.attach` / `tags.detach` |
| `esxi_permission_list` / `esxi_permission_set` / `esxi_permission_remove` | `govc permissions.ls` / `permissions.set` / `permissions.remove` |
| `esxi_role_list` / `esxi_role_create` | `govc role.ls` / `role.create` |
| `esxi_license_list` / `esxi_license_add` / `esxi_license_assign` | `govc license.ls` / `license.add` / `license.assign` |
| `esxi_task_list` / `esxi_event_list` / `esxi_alarm_list` | `govc tasks` / `events` / `alarms` |
| `esxi_library_list` / `esxi_library_deploy` | `govc library.ls` / `library.deploy` |
| `esxi_datacenter_create` | `govc datacenter.create` |

## Known limitations

- **Guest login format** — guest operations use govc's `-l user:password`
  login form; passwords containing `:` are not supported there. Use a guest
  account whose password avoids `:`, or set the guest credentials through
  `GOVC_GUEST_LOGIN`.
- **`esxi_run` gating is heuristic** — the approval gate recognizes a curated
  list of destructive subcommand prefixes; unknown subcommands pass without
  approval. Prefer the dedicated tools for changes, and review any unusual
  `esxi_run` command before approving.
- **Two password stores** — `esxi_connect` passwords live in the credentials
  store (`$DSH_HOME/.credentials.yaml`); settings-panel passwords live in
  `settings.yaml` (both 0600). A profile configured in both places uses the
  settings value.
- **file: link installs** — a local symlink install needs
  `npm install --no-save @deepseek-ai/schemastery` inside the package
  directory for the settings surface; published (tarball/registry) installs
  resolve it from the harness packages automatically. The tools themselves
  work either way.
- **Remote-browser writes** — the settings bridge routes are guarded by the
  same trust fence as the /api gateway; a browser whose origin does not match
  the served host (or whose host is not loopback/trusted) is rejected with
  403 and the card shows "Settings unavailable".

## Development

```sh
node test/core.mjs     # 68 assertions — utilities, store rules, installGovc (stubbed fetch), bridge fence + ops, seed ISO + sha512crypt
node test/smoke.mjs    # 94 assertions — host plugin + tools vs a fake govc + fake ctx
node test/client.mjs   # 28 assertions — browser bundle loads, registers, renders; bridge fallback (react-dom/server)
npm test               # all three
```

The catalog is data-driven: `lib/catalog.js` defines each tool's parameter
schema, govc argv builder, optional JSON formatter, and approval gate; adding
a tool is one table entry. govc flag syntax was verified against the official
[`govc/USAGE.md`](https://raw.githubusercontent.com/vmware/govmomi/main/govc/USAGE.md).

Standards & compliance:

- **Cordis plugin contract** — the package root exports `{ name, inject,
  apply }` exactly like the shipped tool plugins (`name: "esxi"`,
  `inject: ["tools", "systemPrompt"]`); `Config` is intentionally omitted so
  the package stays dependency-free (config is validated manually in `apply`).
- **Tool schema subset** — parameters and output schemas stay inside the
  harness JSON-schema subset (`type`/`properties`/`required`/`enum`/`items`);
  `min`/`max` constraints are enforced by the runtime validator instead, since
  the subset does not carry numeric bounds.
- **Approval seam** — destructive calls gate through `tools/pre-execute`
  (`{ kind: "ask", reason }`), the canonical harness path; no direct
  `approval` service coupling.
- **Settings namespace** — registered host-side (`lib/settings-host.js`)
  against the harness Settings service with a schemastery schema; secrets are
  declared `role("secret")` and re-application is live via `scope.watch`.
- **Client bundle purity gate** — `lib/client.js` is a `__ModuleLoader__`
  factory that requires only `react`; all cross-plugin collaboration goes
  through injected client services (`slots`, `locale`, `settingsScope`),
  declared in `package.json` `dsh.client` with `exports["./client"]`.
- **Testing** — three suites, no network and no LLM: `test/core.mjs` (unit
  tests of the utilities, profile-store persistence rules, and `installGovc`
  against a stubbed fetch serving a fake gzipped binary), `test/smoke.mjs`
  (the whole host plugin against a fake govc + fake ctx, including the
  settings surface and degraded environments), and `test/client.mjs` (the
  browser bundle executed through a fake `window.__ModuleLoader__` and
  rendered with `react-dom/server`, covering en/zh, loading/unavailable,
  read-only, and override states).
- **Docs** — bilingual `README.md` + `README.zh.md` with a
  `README.i18n.yaml` blob-hash consistency record; after editing either side,
  re-record with `git hash-object README.md README.zh.md`.

## License

MIT
