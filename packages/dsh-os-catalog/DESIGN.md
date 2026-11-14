# DESIGN — dsh-os-catalog

状态：MVP `0.1.0`（2026-11-14）。纯 ESM + JSDoc，无构建步骤；核心逻辑不依赖
`@deepseek-ai/*`，可用 `node --test` 离线验证。

## 1. 目标与非目标

**目标**

- 用意图（而不是文件名）发现能力：工具、插件、MCP server、Skill、命令统一建模。
- 在调用前回答三个问题：有没有匹配、现在能不能跑、跑之前缺什么。
- 稳定、可解释、可离线测试：评分与 blocker code 都是确定性的。

**非目标（至少 0.1.x）**

- 不执行任何能力，不代理 I/O，不做权限授予或审批。
- 不自动扫描全部已安装插件；不做文件系统 / 网络发现。
- 不做 embedding / 向量检索，不做持久化数据库，不做 UI。
- 不替代 DSH 工具注册表、MCP client、Skill 索引；只做它们前面的意图索引。

## 2. Manifest 数据模型

### 2.1 字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `id` | string | 是 | — | 全局唯一、稳定的 id。建议命名空间化：`pdf.convert`、`mcp.github.create_pr`。注册时 trim。 |
| `name` | string | 否 | 等于 `id` | 人类可读名，参与检索，权重低于 intents。 |
| `kind` | `tool` \| `plugin` \| `mcp` \| `skill` \| `command` | 是 | — | 注册表家族；缺失直接报错，避免误分类。 |
| `intents` | string[] | 否 | `[]` | 能力的自然语言意图，一条一句；建议中英各写一条。检索主信号。 |
| `inputs` | string[] | 否 | `[]` | 输入名或类型，如 `markdown`、`file path`。 |
| `outputs` | string[] | 否 | `[]` | 输出名或类型，如 `pdf`、`summary`。 |
| `permissions` | string[] | 否 | `[]` | 运行所需权限 id，如 `fs.read`、`net.fetch`。preflight 只用它做覆盖检查。 |
| `cost` | `free` \| `cheap` \| `expensive` | 否 | `cheap` | 声明式成本档；不是精确 token 计量。 |
| `health` | `ok` \| `degraded` \| `down` | 否 | `ok` | 声明式健康状态；0.1.x 不做主动探测。 |
| `meta` | JSON value | 否 | — | 自由 JSON（owner、version、docs URL 等）。深拷贝并冻结；**会回传给 Agent**，不得放秘密。 |

### 2.2 规范化与不变量

- 字符串字段 trim；数组去重（保留首次出现的写法）；空白折叠为单个空格。
- `kind` / `cost` / `health` 只接受枚举，其他类型或未知值抛 `TypeError`。
- 重复 `id` 抛 `CatalogError`，`code = "DUPLICATE_ID"`；seed 中有重复时插件加载失败（fail fast）。
- 每条 manifest 在注册时深拷贝并 `deepFreeze`，调用方后续修改传入对象不会污染目录。
- `meta` 必须是可无损 JSON 化的值（拒绝函数、`undefined`、循环引用、非有限数字）。
- `list()` / `search()` 返回冻结的 manifest 引用；目录内部不暴露可变状态。
- `remove(id)` 返回 boolean；`get(id)` 未命中返回 `undefined`。

### 2.3 示例

```json
{
  "id": "pdf.convert",
  "name": "PDF convert",
  "kind": "tool",
  "intents": ["convert markdown to pdf", "export docs as pdf"],
  "inputs": ["markdown"],
  "outputs": ["pdf"],
  "permissions": ["fs.read", "fs.write"],
  "cost": "cheap",
  "health": "ok",
  "meta": { "owner": "docs-team", "version": "1.2.0" }
}
```

## 3. 检索与评分

### 3.1 流程

1. 查询 NFKC + 小写 + 空白折叠；按 Unicode 字母/数字切 token（CJK 连续串保持完整）。
2. 先应用硬过滤：`kind`、`maxCost`、`requirePermissions`、`health`；默认排除 `down`，
   `includeDown: true` 才纳入。`health` 显式过滤优先于默认规则。
3. 对每个候选的 `intents`、`name`、`inputs` 做 token 匹配；`outputs` 目前不参与打分。
4. 计算短语加分与覆盖率，排序、截断。

### 3.2 权重

| 层次 | 取值 |
|---|---|
| 字段权重 | `intents` 6，`name` 3，`inputs` 1 |
| token 匹配档 | 完全匹配 3，前缀 2，包含 1 |
| 单 token 得分 | 各字段取该字段最佳档位，乘以字段权重后求和 |
| 意图短语加分 | 完全一致 +40，前缀 +18，包含 +8 |
| 名称短语加分 | 完全一致 +20，前缀 +8，包含 +3 |
| 覆盖率 | `1 + 0.15 × (命中的查询 token 数 / 查询 token 总数)` |
| 最终分 | `round((base × coverage + phraseBonus) × 1000) / 1000` |

「完全匹配」对单 token 是 token 相等；对多词查询另由短语加分表达。一次命中的
capability 至少有一个查询 token 落在三个字段之一，否则不进入结果。

排序键：`score` 降序 → `health`（ok > degraded > down）→ `cost`（free < cheap <
expensive）→ `name` 字典序 → `id` 字典序。tie-break 固定，便于测试与审计。

`limit` 默认 20、上限 100；`total` 是截断前命中数。零命中时返回最多 5 条
`{id,name,kind,intents}` 作为 browse 建议。空查询按浏览模式返回全部候选（score 0）。

### 3.3 计算示例

manifest 为 `name: "PDF convert"`、`inputs: ["markdown"]`、
`intents: ["convert markdown to pdf"]`，查询 `convert markdown`：

- `convert`：意图完全匹配 `6×3 = 18`，名称完全匹配 `3×3 = 9`；
- `markdown`：意图完全匹配 `18`，输入完全匹配 `1×3 = 3`；
- base = `18 + 9 + 18 + 3 = 48`；
- 意图短语以查询开头：`+18`；
- 覆盖率 100%：`48 × 1.15 + 18 = 73.2`。

`why` 会记录可读理由，如 `intent exact "convert" in "convert markdown to pdf"`、
`name exact "convert" in "PDF convert"`、`phrase prefix intent: "convert markdown"`。
`why` 是解释与调试用的，不参与二次打分。

### 3.4 权限过滤语义

`requirePermissions` 表示「调用方当前能授予的权限集合」。只有 manifest 的每个
`permissions` 都被该集合覆盖的能力才返回。覆盖规则：

- 精确相等；
- `*` 覆盖一切；
- 尾部通配：`fs.*` 覆盖 `fs.read`、`fs.write`，但不覆盖 `net.fetch`。

这套规则同时用于 `search` 的过滤与 `preflight` 的覆盖检查，避免两处语义漂移。

## 4. Preflight 语义

`preflight(id, {grantedPermissions, maxCost})` 返回：

```js
{
  ok, blockers, warnings,
  id, name, health, cost,
  requiredPermissions, missingPermissions, grantedPermissions
}
```

### 4.1 Blockers

| code | 触发条件 |
|---|---|
| `unknown-capability` | id 未注册（返回 blocker，不抛异常） |
| `health-down` | `health === 'down'` |
| `missing-permission` | 每个未被覆盖的权限一条 |
| `cost-exceeds-budget` | 传了 `maxCost` 且能力档位更高 |

### 4.2 Warnings

| code | 触发条件 |
|---|---|
| `health-degraded` | 能力 `degraded`，可调用但可能只拿到部分结果 |
| `cost-expensive` | 能力为 `expensive` 且未被预算拦下 |

`ok === (blockers.length === 0)`。preflight 是**建议性**的：它不读取 DSH 的真实
approval 状态，不保证底层工具仍存在，也不保证声称的权限就是实际执行的权限。
真实门禁仍由 DSH 工具守卫、用户审批和各能力的实现负责。

## 5. 集成点

### 5.1 边界

- `src/core.js`：纯函数式目录，无 `@deepseek-ai/*` 依赖，所有单测在此层。
- `src/index.js`：Cordis 适配层，仅创建 catalog、注册 3 个工具、把参数转发给 core。
- 外部集成一律通过 `catalog.register()` 写入；不把 adapter 逻辑塞进 core。

### 5.2 工具注册表（tool registry）

DSH 的 `ctx.tools` 服务能枚举当前可见的 `ToolDefinition`。后续只读 adapter 可以把
每个 definition 转成：

```js
{
  id: `tool:${definition.name}`,
  name: definition.name,
  kind: 'tool',
  intents: [definition.description], // 或从中抽取短句
  inputs: Object.keys(definition.parameters?.properties ?? {}),
  permissions: [],                    // 工具 schema 不携带权限，见失败模式
  health: 'ok'
}
```

注意：MVP 不在 `apply` 时自动读取，因为加载顺序可能让先注册的插件看不到后注册的
工具；正式 adapter 应在启动完成后枚举，并订阅注册表变化做增量刷新。

### 5.3 Plugin inventory

Plugin Manager / profile inventory 能给出已启用 bundle 与插件列表。未来 adapter：

- 每个插件生成 `plugin:<packageName>`，`intents` 取包描述与 README 首句；
- `meta` 记录版本、启用状态、来源（profile / 内置）；
- 插件内部的工具仍由 5.2 的 adapter 单独登记，用 `meta.plugin` 关联；
- 只读，不触发安装、启用、禁用。

### 5.4 MCP

MCP client 持有 server 连接状态和 tool 列表。未来 adapter：

- 每条 MCP tool 生成 `mcp:<server>:<tool>`，`kind: 'mcp'`；
- `intents` 取 tool description，`inputs` 取 input schema 的属性名；
- `health` 由连接状态映射：connected → ok，重连中 → degraded，断开 → down；
- `permissions` 从 MCP server 配置推导（例如网络权限），无法推导时留空并在 `meta`
  标记 `permissionsUnknown: true`，避免伪造覆盖；
- 连接/断开事件更新对应 manifest，不让目录与真实状态长期背离。

### 5.5 Skills

Skill 索引或 frontmatter 提供 name / description。未来 adapter：

- 生成 `skill:<name>`，`kind: 'skill'`；
- `intents` 取 description 与触发关键词；
- 若 skill 声明依赖的工具，写入 `meta.tools`，但不复制这些工具的权限；
- Skill 的 prompt/脚本内容不进入 catalog，避免上下文膨胀与秘密泄露。

### 5.6 Commands

命令注册表（若暴露）生成 `command:<name>`。命令通常没有 schema，intents 需要人工
维护或从 help 文本抽取；MVP 不实现。

### 5.7 调用链

```
Agent: "把这份 md 转成 pdf"
  → capability_search("convert markdown to pdf")
  → items[0].cap = { id: "pdf.convert", permissions: ["fs.read","fs.write"], ... }
  → capability_preflight("pdf.convert", { grantedPermissions: [...], maxCost: "cheap" })
  → ok ? 正常调用底层工具 : 先补权限 / 换能力 / 降级
```

目录本身不接触底层工具；执行仍走 DSH 原有工具调用与审批路径。

## 6. 失败模式

| # | 失败模式 | 表现 / 检测 | 缓解 |
|---|---|---|---|
| 1 | 重复 id | 注册抛 `DUPLICATE_ID`，seed 时插件加载失败 | 命名空间化 id；manifest lint；CI 用固定 fixture |
| 2 | manifest 非法 | `TypeError` 指向具体字段 | 在 CI / 发布前校验；未来提供 `catalog validate` CLI |
| 3 | 一个坏 seed 拖垮插件 | `apply` 抛错，3 个工具都不可用 | 当前 fail fast；后续可改为逐条跳过 + warning，但要保证可见 |
| 4 | preflight 未知 id | 返回 `unknown-capability` blocker | 搜索后取 `cap.id`，不要手拼 id |
| 5 | health/cost 过期 | preflight 放行但实际失败/超支 | 声明方负责刷新；未来接入实时探测与 TTL |
| 6 | 通配权限过宽 | `*` 或 `fs.*` 掩盖缺失权限 | 优先精确权限；审计 `grantedPermissions`；未来按 scope 收窄 |
| 7 | meta 泄密 | 搜索输出把秘密发给模型 | 文档红线；未来字段级脱敏 / 禁止 `meta` 某些键 |
| 8 | 不可信 Agent 污染目录 | 注册假能力诱导其他 Agent | `capability_register` 是信任边界；MVP 假设本地受信 Agent；未来加审批/命名空间所有权 |
| 9 | 重启丢注册 | 搜索突然为空 | 用 config seed；未来持久化到 profile 本地文件 |
| 10 | manifest 指向已删除工具 | preflight 通过，执行 `UNKNOWN_TOOL` | 与工具注册表对账；adapter 增量刷新 |
| 11 | 目录膨胀 | 搜索变慢、输出变大 | `limit` 上限；未来倒排索引；基准测试 |
| 12 | 同义词/多语言不匹配 | 搜不到明明存在的能力 | `intents` 写别名；未来可选 embedding 或词表 |
| 13 | 默认隐藏 down 误伤 | 用户以为目录为空 | `includeDown` / `health:"down"` 显式查询；建议里提示 |
| 14 | 评分平局 | 结果顺序在不同机器上漂移 | 固定 tie-break：health → cost → name → id；禁止 locale 比较 |
| 15 | 配置形状错误 | YAML 把数组写成字符串 | `config.capabilities` 必须为数组；字段错误在 `apply` 时报出 |

## 7. 30 天路线

| 时间 | 交付 | 验收 |
|---|---|---|
| Day 0–7（已完成） | `core.js`、3 个工具、12 个测试、README/DESIGN、命名核验 | `node --test` 全绿；`node --check` 通过；npm/GitHub 名称 404 / 0 命中 |
| Day 8–14 | manifest 文件加载（JSON）+ 严格校验 + `catalog validate` 脚本；200 条意图 fixture；Node 24 CI | 非法 manifest 100% 有字段级错误；fixture top-1 命中 ≥ 80% |
| Day 15–21 | 只读 adapter：`ctx.tools.definitions()` 与 plugin inventory；MCP 连接快照与 health 更新；去重/所有权规则 | 启动后目录覆盖当前注册工具；断连 MCP 自动变 down；无自动启用/安装 |
| Day 22–30 | 评分基准与调参、持久化方案（profile 本地快照）、权限审计报告、发布预演 | 1000 条 manifest 下 p95 搜索 < 20 ms；`npm pack --dry-run` 内容正确；决定是否发布 0.2.0 |

**30 天成功指标**

- 意图 fixture 上 top-1 相关率 ≥ 80%，top-3 ≥ 95%；
- 所有 blockers/warnings 都有稳定 code 与文档；
- 非法输入不产生未捕获异常（返回结构化 blocker 或带字段路径的 `TypeError`）；
- adapter 全部只读，不引入网络或安装副作用。

**明确推迟**

- embedding / 向量检索（先验证词法评分是否够用）；
- 自动扫描全部插件（需要 opt-in 与权限模型）；
- 持久化数据库（先用 config seed）；
- UI、市场、跨机器同步。
