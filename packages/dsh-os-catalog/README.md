# dsh-os-catalog

> **Community project. Not affiliated with, sponsored by, or endorsed by DeepSeek.** Apache-2.0. No SLA, no warranty.


> **一句话**：给 DSH Agent 一个按「意图」而不是按文件名找能力的本地能力目录。

`dsh-os-catalog` 是一个 DSH 插件：Agent 问「谁能做这件事」，目录返回按意图排序的
工具 / 插件 / MCP / Skill / Command 清单，以及权限、成本、健康状态和命中理由。

## 为什么

装到 40 个插件之后，Agent 面对的不再是「工具不够」，而是「不知道哪个工具能干这件事」：

- 工具名通常很短，`md_render`、`gh_create`、`run` 之类看不出它服务哪些意图；
- 同一个任务可能由工具、MCP server、Skill 或命令实现，散落在不同注册表；
- 让模型把上百个工具 schema 全读一遍既慢又贵，还容易选错；
- 直接搜文件名只能找到「名字里恰好有这个词」的能力，找不到「意图匹配」的能力。

DSH 已有工具注册表，但注册表回答的是「注册了哪些工具」，不是「我想做 X，该找谁」。
Capability catalog 把每个能力压缩成一条 manifest（id、intents、inputs、outputs、
permissions、cost、health），在调用前先做一次意图检索和准入检查。它**不替代**工具
schema，也不执行工具，只是在「想做什么」和「调哪个能力」之间加一层索引。

## 安装

当前**未发布到 npm**。从本仓库的 `04-build/dsh-os-suite` 检出目录安装：

```sh
cd 04-build/dsh-os-suite
npm install
node --test packages/dsh-os-catalog/test/*.test.js

# 装进一个 DSH profile（bundle 形式）
dsh plugin --profile dev add ./packages/dsh-os-catalog
dsh --profile dev --dump-config   # 应能看到 dsh-os-catalog 层
```

要求：Node 24（无构建步骤，纯 ESM + JSDoc），DSH `>=0.2.3-rc.3 <0.3.0`。

安装后有两种方式填充目录：

1. 运行时调用 `capability_register`（适合另一个插件在 `apply` 时自描述）；
2. 在 profile 的 `cordis.patch.yml` 里按 id 给已安装的 bundle 行补 config：

```yaml
# $DSH_HOME/profiles/dev/cordis.patch.yml
- id: dsh-os-catalog
  config:
    capabilities:
      - id: pdf.convert
        name: PDF convert
        kind: tool
        intents:
          - convert markdown to pdf
          - export documentation as pdf
        inputs: [markdown]
        outputs: [pdf]
        permissions: [fs.read, fs.write]
        cost: cheap
        health: ok
        meta:
          owner: docs-team
```

## 三个工具

### `capability_search`

按意图检索能力。对 `intents`、`name`、`inputs` 做 token 匹配，完全匹配 > 前缀 >
包含；`down` 能力默认隐藏，`degraded` 保留。返回 `{items:[{cap,score,why}], total,
suggestions}`，没有命中时 `items` 为空并给出最多 5 条可浏览建议。

```json
{
  "intent": "convert markdown to pdf",
  "kind": "tool",
  "maxCost": "cheap",
  "requirePermissions": ["fs.read", "fs.write"],
  "limit": 10
}
```

`kind` 可选 `tool|plugin|mcp|skill|command`；`maxCost` 可选 `free|cheap|expensive`；
`requirePermissions` 表示调用方当前可授予的权限集合（支持 `*` 与 `fs.*` 尾部通配），
只有权限被完全覆盖的能力才会返回。

### `capability_preflight`

调用前准入检查：健康状态、成本是否超预算、权限是否被 `grantedPermissions` 覆盖。
返回 `{ok, blockers, warnings, ...}`：

- `health: down` → blocker；`health: degraded` → warning；
- 缺少任一 `permissions` → 每条一个 `missing-permission` blocker；
- 传了 `maxCost` 且能力更贵 → `cost-exceeds-budget` blocker；
- 未传预算但能力是 `expensive` → `cost-expensive` warning；
- 未知 id → `unknown-capability` blocker（不抛异常）。

```json
{
  "id": "pdf.convert",
  "grantedPermissions": ["fs.read"],
  "maxCost": "cheap"
}
```

**这是建议性检查，不授予权限，也不执行能力。** 真正的权限与审批门禁仍在 DSH 内。

### `capability_register`

向当前进程内的目录注册一条 manifest，参数即 Capability 字段（`meta` 为可选 JSON）。
重复 id 会报错。返回 `{registered:true, capability}`。注册只影响当前进程，不发布、
不安装、不执行任何东西。

```json
{
  "id": "pdf.convert",
  "name": "PDF convert",
  "kind": "tool",
  "intents": ["convert markdown to pdf"],
  "inputs": ["markdown"],
  "outputs": ["pdf"],
  "permissions": ["fs.read", "fs.write"],
  "cost": "cheap",
  "health": "ok",
  "meta": { "owner": "docs-team" }
}
```

## 权限与数据

- **manifest 本地**：目录只保存在当前 DSH 进程的内存里；没有文件扫描、没有网络请求、
  没有遥测。数据来源只有 `config.capabilities` 和 `capability_register` 两个入口。
- **不授予权限**：`grantedPermissions` 由调用方传入，目录只做覆盖判断，不读取也不修改
  DSH 的真实 approval 状态。
- **`meta` 对 Agent 可见**：`search` 会把 manifest（含 `meta`）返回给模型，不要把 token、
  密码、内部 URL 等秘密写进 `meta`。
- **无持久化**：重启后注册内容丢失；需要跨重启就通过 config 重新预置静态 manifest。
- 插件本身只注册 3 个工具，不申请额外权限，不执行工具，不写用户目录。

## 限制

- **MVP 不自动扫描全部插件**：必须显式喂 manifest，或由后续的 plugin inventory / MCP
  adapter 读取注册表后转成 Capability。装完插件不会自动出现在目录里。
- **非语义检索**：只有 token / 前缀 / 子串打分，没有 embedding；同义词需要写进
  `intents`（建议中英双语别名各写一条）。
- **health / cost 是自报值**：不做存活探测，也不测量真实 token 成本；manifest 过期就会
  误导，需要调用方维护。
- **不持久化、不跨进程**：`capability_register` 只写当前进程内存。
- **不做权限强制**：`preflight.ok` 只是建议，不能替代 DSH 的审批与工具守卫。
- 大目录的最坏复杂度是 O(能力数 × 查询 token 数)，默认 `limit` 20；上千条前应先加索引。
- 与 plugin inventory、MCP、skills 的正式集成点仍是路线图项，见 [DESIGN.md](./DESIGN.md)。

## 命名核验

2026-11-14 核验：

```sh
$ npm view dsh-os-catalog version
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/dsh-os-catalog - Not found
```

GitHub 仓库名精确搜索：

```sh
$ curl -s 'https://api.github.com/search/repositories?q=dsh-os-catalog+in:name'
{"total_count":0,"incomplete_results":false,"items":[]}
```

即当时 npm 包名与 GitHub 仓库名均未被占用。**发布前必须重新核名**，以发布时结果为准。

## License

Apache-2.0，见 [package.json](./package.json)。无 SLA、无担保。

## 社区项目

这是社区项目，**不是 DeepSeek 官方项目**，与 DeepSeek 无隶属关系，也未获其背书。
问题与改进请在本仓库提 issue / PR。
