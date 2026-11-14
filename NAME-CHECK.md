# 命名核验（2026-11-14 17:15 +08）

## 最终命名

| 包名 | npm registry | GitHub 仓库名精确搜索 | 结论 |
|---|---|---|---|
| `dsh-os-trace` | 404（未占用） | 0 命中 | 可用 |
| `dsh-os-lease` | 404（未占用） | 0 命中 | 可用 |
| `dsh-os-quota` | 404（未占用） | 0 命中 | 可用 |
| `dsh-os-eval` | 404（未占用） | 0 命中 | 可用 |
| `dsh-os-catalog` | 404（未占用） | 0 命中 | 可用 |
| `dsh-os-registry` | 404（未占用） | 0 命中 | 可用 |

**核验命令**：

```sh
# npm：404 = 未占用
curl -s -o /dev/null -w "%{http_code}\n" https://registry.npmjs.org/dsh-os-trace

# GitHub：精确仓库名搜索
curl -s "https://api.github.com/search/repositories?q=dsh-os-trace+in:name" | jq .total_count
```

## 为什么放弃原名

| 原名 | 冲突 |
|---|---|
| `dsh-agent-trace` | npm 404，但 GitHub 有 `goldgish/dsh-agent-trace`（1★） |
| `dsh-workspace-tx` | npm 404，GitHub 0；但语义偏窄（tx 只指事务，不含租约） |
| `dsh-agent-governor` | npm 404，但 GitHub 有 `kxdyh/dsh-agent-governor`（1★） |
| `dsh-agent-eval` | **npm 已占用**（200）；GitHub 5 个同名仓 |
| `dsh-capability-index` | npm 404，但 GitHub 有 `777-Zen/dsh-capability-index`（2★） |
| `dsh-service-registry` | npm 404，GitHub 0；但过于通用，易与云厂商产品混淆 |

**结论**：统一用 `dsh-os-*` 套件名——六个名字在 npm 与 GitHub 都无精确重名，且 `os` 准确表达「治理层/系统服务」，不是「操作系统内核」。

## 描述准确性检查

每条描述都只承诺 MVP 能做的事，不写「official」「OS」「取代」：

- `dsh-os-trace`: Causal audit and tamper-evident evidence bundles for DSH agent runs.
- `dsh-os-lease`: Workspace leases and multi-file transactions for parallel DSH agents.
- `dsh-os-quota`: Token, job and disk budgets with admission control for DSH agents.
- `dsh-os-eval`: Regression eval gates for DSH agents: replay trajectories, compare baselines, fail CI.
- `dsh-os-catalog`: Intent-based capability catalog for DSH tools, plugins and MCP servers.
- `dsh-os-registry`: Local service and port registry for dev servers started by DSH agents.

**注意**：`dsh-os-*` 是社区命名，不代表 DeepSeek 官方；每个 README 必须写明「not affiliated with DeepSeek」。
