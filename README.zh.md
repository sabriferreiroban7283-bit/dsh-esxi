# dsh 插件工作区

[English](README.md) | 中文

本工作区中开发的 DSH（DeepSeek Harness）插件。

## 软件包

### [dsh-esxi](dsh-esxi/)

面向 ESXi / vCenter（vSphere）运维的 DSH 插件：连接配置、清单、虚拟机、主机、
数据存储、网络、集群、资源池、标签、权限、角色、许可证、内容库、
任务/事件/告警、来宾机操作，以及原始 `govc` 透传——共 75 个基于官方 govc CLI
的 `esxi_*` 工具，并为破坏性操作提供审批门。
双语文档：[English](dsh-esxi/README.md) · [中文](dsh-esxi/README.zh.md)。

```sh
cd dsh-esxi
npm test                   # core（68）+ smoke（94）+ client（28），无网络、无 LLM
dsh plugin --profile web add /home/test/projects/plugins/dsh-esxi   # 安装并挂载
```

包内声明了 `dsh.bundle.patch`（见 `cordis.patch.yml`），因此 `dsh plugin` 命令
会自动把它追加到 profile 的 bundle 栈。

## 约定

- 插件保持自包含：导入期只用 Node 内置模块，因此无论从何处安装（registry、
  tarball 或 `file:` 链接）都能解析。
- govc 参数语法对照官方
  [`govc/USAGE.md`](https://raw.githubusercontent.com/vmware/govmomi/main/govc/USAGE.md)
  核对。注意：Go 的 `flag` 包在遇到第一个位置参数后即停止解析，因此每个 argv
  中参数标志必须位于位置参数之前。
- 文档为双语（`README.md` + `README.zh.md`）；编辑任一侧后，请用
  `git hash-object README.md README.zh.md` 更新 `README.i18n.yaml` 中的
  blob 哈希。
