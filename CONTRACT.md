# dsh-os-suite —— 六个「Agent OS 治理层」插件

> 社区项目，**与 DeepSeek 无隶属关系**。所有包使用 Apache-2.0。
> 目标：补齐 DSH 作为「Agent 时代的操作系统」缺的治理层，而不是再做桌面功能。

## 命名（2026-11-14 已核）

| 包名 | 补的 OS 缺口 | 一句话描述 |
|---|---|---|
| `dsh-os-trace` | 因果审计 / 证据链 | Causal audit and tamper-evident evidence bundles for DSH agent runs. |
| `dsh-os-lease` | 工作区事务 / 租约 | Workspace lease intents and multi-file transaction plans for parallel DSH agents. |
| `dsh-os-quota` | 资源配额 / 准入 | Advisory token, job and disk budgets with admission decisions for DSH agents. |
| `dsh-os-eval` | 评测 / 回归 | Regression eval gates for DSH agents: case definitions, baseline comparison and CI verdicts. |
| `dsh-os-catalog` | 能力发现 | Intent-based capability catalog for DSH tools, plugins and MCP servers. |
| `dsh-os-registry` | 服务 / 端口发现 | Local service and port registry for dev servers started by DSH agents. |

**命名核验**：`npm view <name>` 均 404（未占用）；GitHub 仓库名精确搜索均为 0 命中（2026-11-14）。若发布前发生变化，以发布时复核为准。

## 仓库结构

```
packages/
  dsh-os-trace/       # 因果审计
  dsh-os-lease/       # 工作区租约/事务
  dsh-os-quota/       # 资源预算/准入
  dsh-os-eval/        # 回归评测门禁
  dsh-os-catalog/     # 能力目录
  dsh-os-registry/    # 端口/服务注册
```

每个包包含：

- `package.json`：`name`、`version`、`description`、`dsh.bundle.patch`、`engines.dsh`
- `cordis.patch.yml`：bundle 层
- `src/index.js`：Cordis 插件入口，`apply(ctx)` 注册工具
- `src/core.js`：纯逻辑（无 DSH 依赖，可单测）
- `test/core.test.js`：`node --test` 单测
- `README.md`：是什么、为什么、安装、工具、权限、限制、命名核验
- `DESIGN.md`：数据模型、集成点、失败模式、30 天路线

## 约定

- ESM JavaScript + JSDoc（无构建步骤；Node 24 直接运行）。
- 核心逻辑不 import `@deepseek-ai/*`，保证测试可离线跑。
- 插件入口只做「注册工具 + 调用 core」，不写业务逻辑。
- 所有工具必须显式声明 `parameters` 与 `output`。
- 所有包必须写：社区项目、非官方、Apache-2.0、无 SLA。
- 不做：全局搜索、记忆、UI 皮肤、插件市场、快照回滚（红海/官方内置）。

## 运行

```sh
npm install
npm test
```

## 发布（未执行）

```sh
cd packages/dsh-os-trace
npm pack --dry-run
# 确认后：npm publish --access public
```

发布前必须重新核名，并确认 DSH 版本范围。
