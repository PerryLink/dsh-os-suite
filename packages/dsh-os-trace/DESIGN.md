# DESIGN — dsh-os-trace

> 状态：0.1.0 MVP。本文描述**已实现的行为**与**明确的未来接线点**，不把计划写成现状。

## 1. 目标与非目标

### 目标

1. **因果可解释**：给定一个事件 id，返回它和祖先/后代组成的 span 子图与边。
2. **可验证的证据包**：span 进入一条 SHA-256 哈希链；导出 bundle 后，任何单点修改、重排、错误拼接都能定位到第一个坏 span。
3. **可安全分享**：按字段名递归脱敏，重新封链，使校验针对实际分享的字节。
4. **零 DSH 依赖的核心**：`src/core.js` 不 import `@deepseek-ai/*`，`node --test` 可离线运行。
5. **MVP 可嵌**：插件入口只做 store 创建、工具注册和只读 JSONL 导入，不写业务逻辑。

### 非目标（0.1.0）

- 不做 OTel Collector/SDK，不导出 OTLP，不做 W3C trace context 传播。
- 不替代 DSH session 日志、不建全局搜索、不做 UI。
- 不做签名、PKI、透明日志或外部时间戳。
- 不做 SQLite 持久化、跨进程共享、崩溃恢复。
- 不做实时采集接线（见 §4，全部是规划）。

## 2. 架构

```text
packages/dsh-os-trace/
  src/core.js   纯逻辑：规范化、哈希链、store、why、bundle、verify
  src/index.js  Cordis 插件：createTraceStore + 4 个 defineTool + JSONL 只读导入
  test/         core.test.js（领域行为）+ index.test.js（工具/schema 接线）
```

数据流：

```text
JSONL / config.spans
        │  (apply 时一次)
        ▼
  createTraceStore ── ingest ──► 内存 span[] + byId + childrenByParent + ingestOrder
        │
        ├── query(filter) ──► Span[]
        ├── why(id, depth) ──► 子图 + edges + missing
        ├── exportBundle({redact}) ──► bundle（可能重新封链）
        └── verifyBundle(bundle) ──► { ok, firstBad, ... }（无状态，可独立调用）
```

没有模块级可变状态：所有 store 状态在 `createTraceStore()` 闭包里；`verifyBundle` 是纯函数（输入 bundle，输出结果）。

## 3. 数据模型

### 3.1 Span

| 字段 | 类型 | 必填 | 约束 / 含义 |
|---|---|---|---|
| `id` | string | 是 | store 内唯一；非空 |
| `parentId` | string | 否 | 因果父 id；允许指向尚未 ingest 的 id（形成 missing 链） |
| `sessionId` | string | 是 | 来源 DSH session；非空 |
| `agentPath` | string | 否 | 例如 `lead/researcher`；允许空串 |
| `kind` | enum | 是 | `tool` / `subagent` / `job` / `approval` / `mcp` / `workflow` |
| `name` | string | 是 | 操作名；非空 |
| `startMs` | number | 是 | epoch 毫秒；有限值 |
| `endMs` | number | 否 | epoch 毫秒；`>= startMs` |
| `status` | enum | 是 | `ok` / `error` / `running` |
| `attrs` | object | 否 | 任意 JSON 对象；ingest 时深拷贝 |
| `hash` | string | 存储/导出 | 64 位小写十六进制 SHA-256 |
| `prevHash` | string | 存储/导出 | 上一条的 `hash`，创世为 64 个 `0` |

`ingest` 会忽略调用方传入的 `hash`/`prevHash` 并重新计算；未知顶层字段直接报 `INVALID_SPAN`，防止拼写错误变成未受链保护的数据。

### 3.2 不变量

1. 一个 store 只追加一条全局哈希链；顺序 = ingest 顺序，与 `startMs` 无关。
2. 每条 span 的 `hash` 覆盖除 `hash` 外的所有字段（包含 `prevHash` 与 `attrs`）。
3. `parentId` 可以在子节点之后到达，但不能形成环：ingest 会沿已存在的父链检查，闭合环抛 `CAUSAL_CYCLE`。
4. `query` 返回深拷贝，调用方不能通过返回值篡改 store。
5. `why` 不伪造根：父节点缺失时返回 `missing`，不把孤儿当 root。
6. 脱敏导出必然重新封链；未脱敏导出保留原链，因此可与源 store 的 `rootHash` 对照。

### 3.3 因果图

- `byId: Map<string, Span>` 用于 O(1) 定位。
- `childrenByParent: Map<string, Span[]>` 用于向下 BFS。
- `ingestOrder: Map<string, number>` 用于相同 `startMs` 的稳定排序。
- `why(eventId, depth)`：
  - 向上最多 `depth` 跳，遇到缺失父节点记录 id 并停止；
  - 向下 BFS 最多 `depth` 跳；
  - 返回的 `spans` 是包含 target 的、按 `startMs` + ingest order 排序的集合；
  - `edges` 只包含子图内部真实的 parent→child 关系；
  - `truncated` 表示还有节点因深度上限未纳入。
- 深度上限 64，避免一次调用失控；`0` 表示只要 target 本身。

## 4. 集成点（当前均未接线）

下面描述的是**适配器契约**，不是 0.1.0 已实现的功能。接线时应保持「只读事件 → 内存/JSONL」的单向性，禁止写回 session 数据。

| 来源 | 建议 `kind` | 建议 `name` | 关键 `attrs`（示例） | 关系 |
|---|---|---|---|---|
| `session.event` | 视事件而定 | 事件类型 | 事件摘要、模型/回合 id | 根事件或上一事件的子节点 |
| tool call | `tool` | 工具名 | 参数摘要（脱敏）、耗时、错误码 | `parentId` = 发起它的 turn/subagent span |
| approval | `approval` | 策略/审批动作 | 决策、策略 id、是否人工确认 | 作为对应 tool span 的子节点 |
| subagent | `subagent` | 子 agent 名 | agentPath、任务摘要、token 用量 | 父 = 派发它的 tool/turn；子 = 子 agent 内部 tool |
| job | `job` | 命令/任务名 | job id、退出码、是否后台 | 父 = 启动它的 tool；`endMs` 在完成事件补 |
| MCP | `mcp` | `server/tool` | server 名、工具名、耗时、错误码 | 父 = 发起调用的 tool/subagent |
| workflow | `workflow` | 工作流/阶段名 | workflow id、step id、重试次数 | 父 = 触发者；orchestrator 作为祖先 |

接线要求：

1. **关联 id**：tool/approval/job/subagent 的事件必须携带稳定的关联 id，否则无法可靠构造 `parentId`。不能只靠时间邻近。
2. **时间**：优先使用 DSH 事件时间；没有时再用 adapter 接收时间，并在 `attrs` 标注来源，避免把两个时钟混为一谈。
3. **脱敏**：采集阶段就应对参数/结果做与 `redact` 等价的处理，不能先写盘再指望导出时兜底。
4. **失败隔离**：采集失败不能阻塞 agent 主循环；记录 adapter 自身错误，但不伪造 span。
5. **权限**：只订阅 DSH 明确公开的只读事件；不读凭据、不读用户 home 下的私有文件。

## 5. 失败模式

| 失败模式 | 当前行为 | 风险 / 后续 |
|---|---|---|
| 父节点缺失（乱序或丢失） | `why` 返回 `missing`，不补假根 | 因果链断点可见；需要采集端保证完整或提供回填 |
| 重复 `id` | `DUPLICATE_SPAN` | 调用方应先设计稳定事件 id |
| 因果环 | ingest 拒绝；`why` 有 visited 防御 | 事件关联逻辑错误应在上游修复 |
| 子节点先于父节点到达 | 允许；父到达后图自动闭合 | 查询时可能短时间看到 missing |
| 时钟回拨 / 跨机时间 | 原样记录，按 `startMs` 排序 | 链顺序仍按 ingest；不要用时间戳证明因果 |
| 导出时只删尾部 | `spanCount`/`rootHash` 不一致 → `firstBad` | 若攻击者同步改这两个字段，需外部锚 |
| 单点改字段 | `hash mismatch` | 定位到 index/id |
| 重排 / 嫁接连 | `prevHash` 不匹配 | 定位到第一处断链 |
| 整条链重算 | 校验通过 | **本质限制**：链不是签名；需要签名/外部锚 |
| `exportedAt`/`sourceRootHash` 被改 | 不检测 | 这两个字段未封链；不要当证据 |
| 脱敏漏字段 | 只按 key 名匹配，不改字符串内容 | 上游字段命名要规范；必要时先做值级审查 |
| 脱敏过度 | `id`/`parentId` 等被替换会破坏引用 | 文档建议不要 redact 结构字段；后续可加保留字段规则 |
| 超大 store | 一次导出/返回全量，可能超上下文 | 后续分片导出、游标查询 |
| 多 DSH 进程 | 各自独立链，无法互验 | 后续 SQLite/共享存储 + 命名空间 |
| 重启 | 内存清空 | 后续 JSONL append + fsync；当前需调用方保存 bundle |
| JSONL 坏行/文件不存在 | 插件加载失败并带行号 | 故意 fail loud，避免静默丢审计数据 |
| canonical JSON 跨语言差异 | 只保证本包内可复现 | 后续对齐 RFC 8785 或发布测试向量 |
| bundle 版本升级 | `verifyBundle` 拒绝未知 `version` | 格式变更必须 bump version 并保留 v1 verifier |
| 工具权限滥用 | 任何能调工具者都可读全 store | 依赖 DSH tool policy；后续按 session/agent 过滤 |

### 威胁模型

- **能防**：拿到 bundle 后改一条 span、改哈希、重排、截断而不重算；意外损坏；JSONL 解析错误。
- **不能防**：能完整重写 bundle 并重算所有哈希的攻击者；能篡改工具进程内存的攻击者；能伪造源事件的上游；没有外部锚时无法证明「这份 bundle 属于某次特定 run」。
- **下一步**：对 `rootHash` 做 Ed25519 签名，或把 `rootHash` 锚定到 Git commit / 透明日志 / 可信时间戳，才能把「自洽」提升为「可归属」。

## 6. 30 天路线

### 第 1 周：实时采集 MVP（最大缺口）

- 实现只读 `session.event` 适配器：tool / subagent / job / approval / MCP / workflow → span。
- 关联 id 规则与父链构造；缺失父节点只记 missing，不补假根。
- JSONL append sink（可选 fsync），保留 `dataFile` 读取兼容。
- 验收：一次真实 DSH run 能产生 ≥3 层因果链；`trace_why` 能跨 subagent/job 解释；采集失败不阻塞主循环。

### 第 2 周：持久化与可操作性

- 引入只读 SQLite 索引（`node:sqlite` 或等价方案），按 session/时间/kind 建索引；JSONL 作为原始 append log。
- 增加 `trace verify <bundle.json>` CLI 或等价离线入口；支持从文件加载 bundle 校验。
- 分页/游标查询，避免一次扫描全量。
- 验收：1 万 span 的 store 查询 P95 可接受；离线校验不依赖 DSH 运行时。

### 第 3 周：证据强度与隐私

- 对 `rootHash` 做 Ed25519 签名（密钥生命周期、轮换、公钥分发文档）。
- 可选外部锚：把签名后的 root 写入 Git note / 透明日志适配器。
- 脱敏策略 v2：路径规则、允许列表、结构字段保护、值级 secret 检测（谨慎，默认关闭）。
- 发布 canonical JSON 测试向量，降低跨实现漂移。
- 验收：篡改 + 重算的 bundle 能被签名/锚验证拒绝；脱敏后仍可通过签名验证。

### 第 4 周：发布与生态

- 补齐 OTel **导入**（不是实时 OTel 后端）：把 OTLP/JSON 或 OTel span 映射为本模型，明确字段损失。
- 文档、示例 run、npm `pack` 检查、版本范围复核。
- 发布 0.1.x 到 npm；收集真实 run 的兼容性反馈。
- 验收：干净环境 `dsh plugin add` + 四个工具可用；`npm pack --dry-run` 文件清单符合预期；README/DESIGN 无未实现承诺。

## 7. 版本与兼容

- bundle `format: "dsh-os-trace/bundle"`，`version: 1`；不兼容变更必须 bump `version`，并保留旧版 verifier。
- `verifyBundle` 对未知 `format`/`version` 返回 `ok: false`，不做猜测性解析。
- `core.js` 的公开函数：`createTraceStore`、`verifyBundle`、`canonicalJson`、`computeSpanHash`、`normalizeSpan`；语义变更按 semver 处理。
- 包要求 DSH `>=0.2.2-rc.3 <0.3.0`；DSH 事件 API 变化时，适配器单独发版，不改动已导出的 bundle 格式。
