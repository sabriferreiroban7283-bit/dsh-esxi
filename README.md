# dsh plugins workspace

English | [中文](README.zh.md)

DSH (DeepSeek Harness) plugins developed in this workspace.

## Packages

### [dsh-esxi](dsh-esxi/)

DSH plugin for ESXi / vCenter (vSphere) operations: connection profiles,
inventory, VMs, hosts, datastores, networking, clusters, resource pools, tags,
permissions, roles, licensing, content library, tasks/events/alarms, guest
operations, and raw `govc` passthrough — 75 `esxi_*` tools backed by the
official govc CLI, with an approval gate for destructive operations.
Bilingual docs: [English](dsh-esxi/README.md) · [中文](dsh-esxi/README.zh.md).

```sh
cd dsh-esxi
npm test                   # core (68) + smoke (94) + client (28), no network, no LLM
dsh plugin --profile web add /home/test/projects/plugins/dsh-esxi   # install & mount
```

The package declares `dsh.bundle.patch` (see `cordis.patch.yml`), so the
`dsh plugin` command appends it to the profile bundle stack automatically.

## Conventions

- Plugins are self-contained: only Node builtins at import time, so they
  resolve from any install location (registry, tarball, or `file:` link).
- govc flag syntax is verified against the official
  [`govc/USAGE.md`](https://raw.githubusercontent.com/vmware/govmomi/main/govc/USAGE.md).
  Remember: Go's `flag` package stops parsing at the first positional
  argument, so flags must precede positionals in every argv.
- Docs are bilingual (`README.md` + `README.zh.md`); after editing either
  side, update the blob hashes in `README.i18n.yaml`
  (`git hash-object README.md README.zh.md`).
