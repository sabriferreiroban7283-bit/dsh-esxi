# dsh-esxi

[English](README.md) | 中文

面向 **ESXi / vCenter（vSphere）运维** 的 DSH 插件。它覆盖 vSphere 环境完整的
day-2 管理面——vCenter Server、独立 ESXi 主机、集群，以及周边生态（vSAN、
内容库、标签、权限、许可证、任务/事件/告警）——通过一整套基于 VMware 官方
[govc](https://github.com/vmware/govmomi) CLI 的 `esxi_*` 工具实现。

```
dsh plugin --profile web add dsh-esxi
```

一条命令即可安装并挂载插件（包内声明了 `dsh.bundle.patch`，配置文件束栈会自动
更新）。

## 工作原理

- **连接配置（profile）** —— `esxi_connect` 把 vCenter/ESXi 端点信息（URL、
  用户名、数据中心、文件夹、TLS 模式）保存在 `<dsh home>/esxi/profiles.json`。
  密码走 harness 的**凭据存储**（`$DSH_HOME/.credentials.yaml`），绝不写入
  profiles 文件。
- **govc 运行器** —— 每个工具都以该配置对应的 `GOVC_*` 环境变量调用 `govc`。
  参数通过 `execFile` 以 `argv` 形式传入——**全程不经过任何 shell**——并带
  有按工具区分的超时与输出截断。
- **审批门（approval gate）** —— 破坏性操作（删除/关机 VM、主机维护/重启、
  删除数据存储文件、修改权限、esxcli、`esxi_run` 执行破坏性子命令等）在执行
  前会通过 harness 的审批通道征求用户同意。
- **设置面板** —— 「设置」侧边栏直接出现 **「ESXi / vCenter」** 入口（通过
  `dsh-esxi` 设置命名空间与 `settings.section` 插槽注册，与 better-sidebar
  自己的设置分区同机制），可配置 govc
  二进制、超时参数、输出上限、审批开关与连接配置（ESXi 主机信息）。值保存在
  `$DSH_HOME/settings.yaml`（权限 0600），实时生效；设置面板托管的 profile
  会覆盖 `esxi_connect` 中同名配置。
- **零依赖** —— 包在运行时只导入 Node 内置模块（外加为设置界面惰性导入的、
  可选的 `@deepseek-ai/schemastery`），因此无论从何处安装（registry、tarball
  或本地 `file:` 链接）都能加载；设置界面无法解析时优雅降级，工具照常工作。

## 环境要求

- `PATH` 中有 `govc`（或通过插件配置 `govcPath` 指定路径）。若缺失，
  `esxi_doctor {install: true}` 会把官方发布的二进制下载到
  `<dsh home>/esxi/bin`。
- dsh 所在主机到 vCenter/ESXi 管理面（443 端口）网络可达。
- 来宾机操作（`esxi_guest_*`）要求虚拟机内已运行 VMware Tools。
- 设置面板需要 **web** profile（浏览器界面）；分区直接出现在「设置」
  侧边栏，名为「ESXi / vCenter」。
- Node >= 20。

## 安装与配置

```sh
# 安装到 web profile（headless 或自定义 profile 同样适用）
dsh plugin --profile web add dsh-esxi
```

配置挂在插件行上；可在 profile 的 `cordis.patch.yml` 中覆盖：

```yaml
# $DSH_HOME/profiles/<name>/cordis.patch.yml
- id: esxi
  config:
    govcPath: /opt/govc/bin/govc        # 二进制名或绝对路径（默认 "govc"）
    installDir: ~/.dsh/esxi/bin         # esxi_doctor 安装 govc 的目录
    profilesFile: ~/.dsh/esxi/profiles.json
    defaultTimeoutMs: 120000            # 普通命令超时（毫秒）
    longTimeoutMs: 600000               # 导出/上传/克隆/迁移超时（毫秒）
    maxOutputChars: 30000               # 模型可见输出上限（字符）
    infoCap: 100                        # vm/host 列表批量补全上限
    inventoryMaxItems: 100              # esxi_inventory 中每种类型展示的名称数
    approveDestructive: true            # 审批门总开关
```

## 快速上手

1. `esxi_doctor` —— 检查 govc 二进制（加 `install: true` 可自动下载）。
2. `esxi_connect` —— 添加连接配置：
   ```
   esxi_connect { profile: "prod", url: "vc01.example.com", username: "administrator@vsphere.local", password: "...", datacenter: "DC1" }
   ```
3. `esxi_about` —— 确认连通性与版本。
4. `esxi_inventory` —— 梳理环境（按对象类型统计数量）。
5. `esxi_vm_list {details: true}` —— 查看虚拟机及其电源状态、IP。
6. `esxi_vm_power {vm: "web-01", operation: "off"}` —— 批准破坏性操作提示，
   然后观察任务结果。

独立 ESXi 主机的用法相同：把配置直接指向主机即可（`url: "esxi-host",
username: "root", insecure: true`）。

未配置任何 profile 时，只要导出了 `GOVC_URL`、`GOVC_USERNAME`、
`GOVC_PASSWORD`（等）环境变量，工具会自动回退到环境变量模式。任意工具带上
显式的 `profile` 参数，可只对本次调用覆盖默认配置。

## 设置面板（Web 界面）

插件在 DSH 设置中自带专用配置界面：**设置 → "ESXi / vCenter"** ——
「设置」侧边栏的直接入口，点击即打开。这是一个原生 `settings.section`，
绑定 `dsh-esxi` 设置
命名空间（`settings.yaml`，权限 0600），与内置插件卡片采用同一套机制。

可编辑内容：

| 分组 | 字段 |
|---|---|
| govc 运行时 | `govcPath`、`installDir`、`profilesFile` |
| 超时与输出 | `defaultTimeoutMs`、`longTimeoutMs`、`maxOutputBytes`、`maxOutputChars`、`infoCap`、`inventoryMaxItems` |
| 安全 | `approveDestructive`（实时生效，无需重启） |
| 连接配置（ESXi 主机信息） | 每个 profile：`name`、`url`、`username`、`password`（机密）、`insecure`、`datacenter`、`folder`、`tlsCaCerts`；支持增删行 |

行为与保障：

- 编辑是**暂存式**的：字段展示解析后的值与「已覆盖」徽标；保存只写入变更字段
  （带修订号防冲突），放弃即回退，逐字段「重置」回到 schema 默认值。
- 值**立即生效**（主机在每次变更后重新应用命名空间）——包括审批开关与新增
  profile。
- 设置面板托管的 profile 在 `esxi_profiles` 中标为 `(settings)`，覆盖
  `esxi_connect` 中同名配置，且**绝不写入 `profiles.json`**（只存在于设置文档
  中）。
- 密码在命名空间 schema 中声明为 `role("secret")`，设置链路会自动脱敏
  （`settings.describe({ redactSecrets: true })`）；密码存于 `settings.yaml`
  （0600），保存后不再回显。
- **远程浏览器** —— 原生设置 RPC 仅限环回，通过 `--trusted-host` 提供的 GUI
  会看到 "unavailable"。卡片会透明回退到插件自身的 `/esxi/settings.get` 与
  `/esxi/settings.save` JSON 路由，主机侧使用与 API 网关相同的浏览器信任围栏
  （Host 头环回或 web 运行时的可信主机，加同源标记）防护。
- 降级：若无法解析 `@deepseek-ai/schemastery`（少见安装位置），工具照常工作，
  仅跳过设置界面。本地 `file:` 链接安装时，在包目录执行
  `npm install --no-save @deepseek-ai/schemastery` 即可启用。

### 手动编辑设置（headless / CI）

同一个命名空间可以直接编辑设置文档——适用于没有浏览器面板的 headless
profile 与自动化场景：

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
      url: vc01.example.com          # 规范化为 https://vc01.example.com/sdk
      username: administrator@vsphere.local
      password: "..."                # 机密——设置链路自动脱敏
      insecure: true
      datacenter: DC1
```

插件会热重载该文档（`scope.watch`），编辑后无需重启即可生效；设置面板托管
的 profile 不会写入 `profiles.json`。

## 示例

**一键安装操作系统（云镜像 + cloud-init——云主机/VPS 同款流程，推荐）：**

完全没有安装程序和交互界面。先下载官方 Ubuntu 云镜像 OVA（自带
open-vm-tools），然后：

```
# 1. 导入官方云镜像（本地文件经 SDK 直接流式上传）
esxi_vm_import { file: "/data/noble-server-cloudimg-amd64.ova", name: "ubuntu-2404", datastore: "datastore2" }
# 2. 扩容磁盘、设定规格，并在首次开机前注入 cloud-init 种子
esxi_vm_disk { vm: "ubuntu-2404", operation: "resize", name: "disk-1000-0", size: "100GB" }
esxi_vm_change { vm: "ubuntu-2404", cpu: 4, memory: 8192 }
esxi_vm_cloudinit { vm: "ubuntu-2404", userData: "#cloud-config\nhostname: ubuntu-2404\nusers:\n  - name: ubuntu\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    lock_passwd: false\n    hashed_passwd: '$6$...'  # SHA-512 crypt 哈希；cloud-init 26.x 会静默忽略旧的 passwd: 键\nssh_pwauth: true" }
# 3. 开机——cloud-init 自动完成主机名/用户/SSH 并扩容文件系统
esxi_vm_power { vm: "ubuntu-2404", operation: "on" }
```

已在 ESXi 8.0 + `noble-server-cloudimg-amd64.ova` 上端到端验证：开机 →
cloud-init（`DataSourceVMware [seed=guestinfo]`）→ `status: done`，`lsblk`
显示 `sda1 99G /`，种子用户可正常登录。用户名不要与镜像里已有的**组**重名
（镜像自带 `admin` 组，`useradd admin` 会失败——惯例用 `ubuntu`）。

**无人值守 Ubuntu autoinstall（服务器 ISO，端到端）：**

24.04+ 的 subiquity 只有在内核带 `autoinstall` 参数时才进入自动安装模式，
需要配合改过 GRUB 的 ISO；或者直接用上面无需 ISO 的云镜像流程：

```
esxi_vm_create { name: "ubuntu-2404", cpu: 4, memory: 8192, disk: "100GB", datastore: "datastore2", guestId: "ubuntu64Guest", firmware: "efi", network: "VM Network", powerOn: false }
esxi_seed_iso { name: "ubuntu-2404-seed", hostname: "ubuntu-2404", username: "admin", password: "changeme", datastore: "datastore2", packages: "open-vm-tools" }
esxi_vm_iso { vm: "ubuntu-2404", operation: "add" }                                  # 第一个光驱
esxi_vm_iso { vm: "ubuntu-2404", operation: "insert", datastore: "datastore1", iso: "iso/ubuntu-24.04.4-live-server-amd64.iso" }
esxi_vm_iso { vm: "ubuntu-2404", operation: "add" }                                  # 第二个光驱
esxi_vm_iso { vm: "ubuntu-2404", operation: "insert", datastore: "datastore2", iso: "iso/ubuntu-2404-seed.iso" }
esxi_vm_boot { vm: "ubuntu-2404", order: "cdrom,disk" }
esxi_vm_power { vm: "ubuntu-2404", operation: "on" }                                 # 无人值守安装
# 完成后：恢复磁盘启动并删除种子 ISO
esxi_vm_boot { vm: "ubuntu-2404", order: "disk" }
esxi_datastore_delete { datastore: "datastore2", path: "iso/ubuntu-2404-seed.iso" }
```

种子 ISO 是一个 cloud-init NoCloud `cidata` 卷，内含 `autoinstall` user-data
（身份信息使用 SHA-512 crypt 密码哈希、direct 磁盘布局、SSH、额外软件包）——
数据存储上只会留下哈希，不会留下明文密码。

**从模板克隆一台 VM 并打快照：**

```
esxi_vm_clone { vm: "tpl-web", name: "web-02", datastore: "datastore1", pool: "/DC1/host/Cluster1/Resources/web" }
esxi_vm_snapshot { vm: "web-02", operation: "create", name: "baseline", memory: false }
```

**扩容磁盘并添加网卡：**

```
esxi_vm_disk   { vm: "db-01", operation: "resize", name: "db-01/db-01.vmdk", size: "200GB" }
esxi_vm_network { vm: "db-01", operation: "add", network: "VM Network", adapter: "vmxnet3" }
```

**主机维护与 esxcli：**

```
esxi_host_maintenance { host: "esxi-02", mode: "enter", evacuate: true }
esxi_host_esxcli      { host: "esxi-02", args: "storage vmfs list" }
esxi_host_esxcli      { host: "esxi-02", args: "network ip route ipv4 list" }
```

**数据存储上传/下载：**

```
esxi_datastore_upload   { datastore: "datastore1", localPath: "config.iso", remotePath: "web-02/config.iso" }
esxi_datastore_download { datastore: "datastore1", remotePath: "web-02/vmware.log", localPath: "vmware.log" }
```

**专用工具未覆盖的任意操作：**

```
esxi_run { args: "vsan.info ClusterA" }
esxi_run { args: "option.set log.level info" }
esxi_run { args: "collect /DC1/vm/db-01 runtime.powerState" }
```

## 工具总览

| 领域 | 工具 |
|---|---|
| 配置与环境 | `esxi_connect`, `esxi_disconnect`, `esxi_profiles`, `esxi_set_default`, `esxi_about`, `esxi_doctor` |
| 清单/库存 | `esxi_inventory`, `esxi_find`, `esxi_collect`, `esxi_tree` |
| 虚拟机 | `esxi_vm_list`, `esxi_vm_info`, `esxi_vm_power`, `esxi_vm_create`（含 `iso`/`isoDatastore`）、`esxi_vm_import`（OVA/OVF）、`esxi_vm_cloudinit`（guestinfo 种子）、`esxi_vm_iso`、`esxi_vm_boot`、`esxi_vm_serial`（控制台采集/telnet）、`esxi_seed_iso`、`esxi_vm_clone`, `esxi_vm_change`, `esxi_vm_disk`, `esxi_vm_network`, `esxi_vm_snapshot`, `esxi_vm_migrate`, `esxi_vm_export`, `esxi_vm_template`, `esxi_vm_register`, `esxi_vm_unregister`, `esxi_vm_delete` |
| 来宾机操作 | `esxi_guest_exec`, `esxi_guest_file` |
| 数据存储 | `esxi_datastore_list`, `esxi_datastore_browse`, `esxi_datastore_upload`, `esxi_datastore_download`, `esxi_datastore_copy`, `esxi_datastore_delete`, `esxi_datastore_create` |
| 网络 | `esxi_network_list`, `esxi_portgroup_add`, `esxi_portgroup_remove`, `esxi_vswitch_list`, `esxi_vswitch_add`, `esxi_vswitch_remove` |
| 主机 | `esxi_host_list`, `esxi_host_info`, `esxi_host_maintenance`, `esxi_host_power`, `esxi_host_esxcli`, `esxi_host_add`, `esxi_host_remove`, `esxi_host_reconnect`, `esxi_host_service`, `esxi_host_option` |
| 集群与资源池 | `esxi_cluster_create`, `esxi_cluster_info`, `esxi_cluster_change`, `esxi_pool_list`, `esxi_pool_create`, `esxi_pool_change`, `esxi_pool_destroy` |
| 管理 | `esxi_tag_list`, `esxi_tag_create`, `esxi_tag_attach`, `esxi_permission_list`, `esxi_permission_set`, `esxi_permission_remove`, `esxi_role_list`, `esxi_role_create`, `esxi_license_list`, `esxi_license_add`, `esxi_license_assign`, `esxi_task_list`, `esxi_event_list`, `esxi_alarm_list`, `esxi_library_list`, `esxi_library_deploy`, `esxi_datacenter_create` |
| 原始透传 | `esxi_run` —— 任意 govc 命令（如 `vsan.info ClusterA`、`import.ova`、`cluster.rule.*`、`alarm.info`、`option.set`） |

### 要点说明

- **名称/路径**：所有对象参数都接受名称或清单路径（`/DC1/vm/MyVM`）。当
  profile 设置了数据中心时，短名称会相对其解析。
- **`esxi_run`** 会安全地解析命令行（支持引号/转义），并把 argv 直接交给
  govc——绝不经过 shell。第一个参数必须是 govc 子命令。一份精选的破坏性
  子命令前缀清单会触发审批门。
- **`esxi_host_esxcli`** 通过 `govc host.esxcli` 覆盖主机管理的长尾
  （存储、网络、软件、服务、系统、硬件）。所有 esxcli 调用都经过审批门。
- **`esxi_vm_disk` 的 detach** 会在数据存储上保留磁盘文件
  （`device.remove -keep`）；之后是否删除文件是另一个独立的
  `esxi_datastore_delete` 决策。
- **`esxi_vm_export`** 会写出一个 OVF 目录；`ova: true` 时再用 `tar` 打包。
- **vSAN / 内容库 / 告警 / 高级选项** 可通过 `esxi_run` 触达（`govc
  vsan.info`、`govc library.*`、`govc alarms`、`govc option.set`）——上面
  的专用工具集以结构化参数覆盖了最常见的操作。

## 安全说明

- 密码存于 harness 凭据存储（`$DSH_HOME/.credentials.yaml`，权限 0600），
  引用名形如 `ESXI_PASSWORD_PROD`；profiles 文件不含任何机密。
- 破坏性操作默认失败关闭：没有可用的审批通道（或无人值守会话）时，调用会被
  拒绝而不是执行。
- `esxi_connect` 默认提供 `insecure: true`（针对自签名 vCenter 证书）；生产
  环境建议改用 `tlsCaCerts` 指向你的 CA 捆绑包。
- 来宾机操作的密码会以命令行参数传给 govc（调用期间在 dsh 主机的进程表中
  可见）。
- 设置面板中的密码存于 `$DSH_HOME/settings.yaml`（权限 0600），在命名空间
  schema 中声明为 `role("secret")`（设置链路自动脱敏），插件此后仅在内存中
  持有。

## 故障排查

| 现象 | 原因 / 解决办法 |
|---|---|
| `govc: command not found` / `govc not runnable` | 未安装 govc。运行 `esxi_doctor {install: true}` 下载官方二进制，或在插件配置 `govcPath` 中指定已有二进制。 |
| `x509: certificate signed by unknown authority` | 自签名 vCenter 证书导致 TLS 校验失败。用 `insecure: true` 重新连接，或设置 `tlsCaCerts` 指向你的 CA。 |
| `ServerFaultCode: Permission to perform this operation was denied` | 该配置账号缺少所需权限。用 `esxi_permission_list` 检查主体的角色，用 `esxi_permission_set` 授权。 |
| `Cannot complete login due to an incorrect user name or password` | 凭据错误，或账号被锁定/禁用。vCenter SSO 用 `administrator@vsphere.local`；独立主机用 `root`。 |
| `[timed out after …]` | 操作超过 `defaultTimeoutMs`。在插件配置中调大，或用 `esxi_run {timeoutMs: …}`，或缩小范围（如用 `esxi_find` 代替 `esxi_inventory`）。 |
| `esxi_run` 报 `unknown command: …` | 你的 govc 版本没有该子命令。先 `esxi_run {args: "version"}`，再对照 [govc 文档](https://github.com/vmware/govmomi/blob/main/govc/USAGE.md)。 |
| 当前平台不支持 govc 自动安装 | `esxi_doctor` 自动安装覆盖 linux/darwin 的 amd64+arm64（以及 Windows 旧版命名）。否则请到 [releases 页](https://github.com/vmware/govmomi/releases) 手动下载。 |
| 来宾机操作报 `GuestOperationsUnavailable` | 虚拟机内 VMware Tools 未运行（或过旧）；先安装/升级 Tools（`esxi_run {args: "vm.guest.tools -upgrade <vm>"}`）。 |

## govc 命令映射（附录）

每个工具都封装一个 govc 子命令（`esxi_run` 是通用的兜底入口）。下表用于快速
查阅；工具自身的参数说明仍是权威依据。

| 工具 | govc 命令 |
|---|---|
| `esxi_about` | `govc about` |
| `esxi_inventory` / `esxi_find` / `esxi_tree` / `esxi_collect` | `govc find`、`govc ls`、`govc tree`、`govc collect` |
| `esxi_vm_list` / `esxi_vm_info` | `govc find -type m`、`govc vm.info` |
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
| `esxi_host_list` / `esxi_host_info` | `govc find -type h`、`govc host.info` |
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

## 已知限制

- **来宾机登录格式** —— 来宾机操作使用 govc 的 `-l user:password` 登录形式，
  不支持含 `:` 的密码。请使用密码不含 `:` 的来宾机账号，或通过
  `GOVC_GUEST_LOGIN` 提供来宾机凭据。
- **`esxi_run` 的审批判断是启发式的** —— 审批门只识别一份精选的破坏性子命令
  前缀清单；未知子命令会不经审批直接执行。变更操作请优先使用专用工具，批准
  前仔细审查任何不常见的 `esxi_run` 命令。
- **两套密码存储** —— `esxi_connect` 的密码在凭据存储
  （`$DSH_HOME/.credentials.yaml`）；设置面板的密码在 `settings.yaml`（均为
  0600）。两处都配置了同名 profile 时，以设置面板的值为准。
- **file: 链接安装** —— 本地符号链接安装需要在包目录执行
  `npm install --no-save @deepseek-ai/schemastery` 才能启用设置界面；发布
  （tarball/registry）安装会自动从 harness 包解析。无论哪种安装，工具本身都
  正常工作。
- **远程浏览器写入** —— 设置桥接路由使用与 /api 网关相同的信任围栏防护：
  浏览器来源与服务主机不一致（或主机非环回/可信）会被 403 拒绝，卡片显示
  "Settings unavailable"。

## 开发

```sh
node test/core.mjs     # 68 条断言——工具函数、存储规则、installGovc（桩 fetch）、桥接围栏与 ops、种子 ISO + sha512crypt
node test/smoke.mjs    # 94 条断言——主机插件 + 工具 vs 伪造 govc + 伪造 ctx
node test/client.mjs   # 28 条断言——浏览器 bundle 加载、注册、渲染；桥接回退（react-dom/server）
npm test               # 三个全跑
```

工具目录是数据驱动的：`lib/catalog.js` 中定义了每个工具的参数 schema、govc
argv 构造器、可选的 JSON 格式化器与审批门；新增一个工具就是加一行表项。govc
参数语法均对照官方
[`govc/USAGE.md`](https://raw.githubusercontent.com/vmware/govmomi/main/govc/USAGE.md)
核对过。

标准与规范：

- **Cordis 插件契约** —— 包根与官方工具插件一样导出 `{ name, inject, apply }`
  （`name: "esxi"`、`inject: ["tools", "systemPrompt"]`）；刻意不导出
  `Config`，以保持包零依赖（配置在 `apply` 中手动校验）。
- **工具 schema 子集** —— 参数与输出 schema 均保持在 harness JSON-schema
  子集内（`type`/`properties`/`required`/`enum`/`items`）；`min`/`max` 约束由
  运行时校验器执行（子集不承载数值边界）。
- **审批通道** —— 破坏性调用通过 `tools/pre-execute`（`{ kind: "ask",
  reason }`）走 harness 的标准审批路径，不直接耦合 `approval` 服务。
- **设置命名空间** —— 由主机侧（`lib/settings-host.js`）用 schemastery
  schema 向 harness Settings 服务注册；机密字段声明为 `role("secret")`，
  通过 `scope.watch` 实时重新应用。
- **客户端 bundle 纯净门禁** —— `lib/client.js` 是 `__ModuleLoader__`
  factory，只 `require("react")`；所有跨插件协作都走注入的客户端服务
  （`slots`、`locale`、`settingsScope`），在 `package.json` 的 `dsh.client`
  中声明（`exports["./client"]`）。
- **测试** —— 三套测试，无网络、无 LLM：`test/core.mjs`（工具函数、profile
  存储持久化规则，以及以桩 fetch 提供伪造 gzip 二进制的 `installGovc` 单测）、
  `test/smoke.mjs`（整个主机插件 vs 伪造 govc + 伪造 ctx，含设置界面与降级
  环境）、`test/client.mjs`（浏览器 bundle 通过伪造 `window.__ModuleLoader__`
  执行，用 `react-dom/server` 渲染，覆盖中英文、加载中/不可用、只读与覆盖
  状态）。
- **文档** —— 双语 `README.md` + `README.zh.md`，并附 `README.i18n.yaml`
  blob 哈希一致性记录；编辑任一侧后，用
  `git hash-object README.md README.zh.md` 重新记录。

## 许可证

MIT
