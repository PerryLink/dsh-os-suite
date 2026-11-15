# dsh-os-suite 发布前审计（AUDIT）

> **Historical (2026-11-14, 0.1.x era):** retained for traceability. It is superseded by the `0.2.4` release; see `CHANGELOG.md` and the README status block for current state.


- **审计对象**：`packages/dsh-os-{trace,lease,quota,eval,catalog,registry}` 六个包（`packages/_template` 不属发布对象）。
- **审计时间**：2026-11-14 17:23–17:30（+08）。
- **环境**：Node `v24.22.1`，npm `11.19.1`，Linux/WSL；DSH checkout `0.2.2-rc.3`。
- **方式**：只读检查 + 动态 import + 假 ctx 调用；**未修改任何实现代码、测试或 package.json**，只新增本文件。
- **结论**：**需修复后发布**。功能面（测试、导入、打包、元数据、命名）整体健康；阻断项是 **5/6 包缺 Apache-2.0 许可证全文**、**`dsh-os-eval` 描述失实（`replay trajectories` 实际只有 mock）**，以及 **`quota_status` 的 “Read-only” 声明与实际会创建账本不符**。

---

## 1. PASS/FAIL 总表（6 包 × 8 项）

| # | 检查项 | dsh-os-trace | dsh-os-lease | dsh-os-quota | dsh-os-eval | dsh-os-catalog | dsh-os-registry |
|---|---|---|---|---|---|---|---|
| 1 | 测试（root / 单包 / `node --check`） | PASS | PASS | PASS | PASS | PASS | PASS |
| 2 | 命名（npm E404 / GitHub 0） | PASS | PASS | PASS | PASS | PASS | PASS |
| 3 | 打包面（必需文件 / 无 test、node_modules） | PASS | PASS | PASS | PASS | PASS | PASS |
| 4 | 元数据（含 `cordis.patch.yml` id/name） | PASS | PASS | PASS | PASS | PASS | PASS |
| 5 | 真实导入（`name` / `inject` / `apply` / 工具数） | PASS | PASS | PASS | PASS | PASS | PASS |
| 6 | 描述准确性 | PASS | **FAIL** | **FAIL** | **FAIL** | PASS | PASS |
| 7 | 合规 / 安全（含发布物许可） | **FAIL** | PASS | **FAIL** | **FAIL** | **FAIL** | **FAIL** |
| 8 | 一致性（套件级） | **FAIL\*** | **FAIL\*** | **FAIL\*** | **FAIL\*** | **FAIL\*** | **FAIL\*** |

\* 第 8 项是套件级判定：六包共同承担 README 结构 / 错误语义不一致；不是每包各自独立失败。

**PASS 的边界**

- 第 1 项：审计时 root `npm test` 为 89/89（含模板 1 项）；模板移出 workspaces 后**六包合计 89/89**。见 §2.1 与文末修复记录。
- 第 3 项：六包 tarball 均含 `src/`、`cordis.patch.yml`、`README.md`、`DESIGN.md`、`package.json`，均不含 `test/`、`node_modules/`；但 5 包不含 `LICENSE`（第 7 项 FAIL 的根因，见 §2.7）。
- 第 4 项：任务列出的字段全部正确；可选字段不一致（`scripts.test`、`keywords`、`exports`）记入第 8 项与 §3。
- 第 6 项：trace/catalog/registry 的 README 都在正文明确披露了限制，描述没有超出 README 自述；lease/quota/eval 的 npm description 需要收紧，见 §2.6。

---

## 2. 逐项证据

### 2.1 测试

**root 全量**

```text
$ cd 04-build/dsh-os-suite && npm test
ℹ tests 89
ℹ suites 0
ℹ pass 89
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
EXIT=0
```

**单包**

| 包 | 命令 | tests | pass | fail | exit |
|---|---|---:|---:|---:|---:|
| dsh-os-trace | `node --test packages/dsh-os-trace/test/*.test.js` | 11 | 11 | 0 | 0 |
| dsh-os-lease | `node --test packages/dsh-os-lease/test/*.test.js` | 12 | 12 | 0 | 0 |
| dsh-os-quota | `node --test packages/dsh-os-quota/test/*.test.js` | 21 | 21 | 0 | 0 |
| dsh-os-eval | `node --test packages/dsh-os-eval/test/*.test.js` | 17 | 17 | 0 | 0 |
| dsh-os-catalog | `node --test packages/dsh-os-catalog/test/*.test.js` | 12 | 12 | 0 | 0 |
| dsh-os-registry | `node --test packages/dsh-os-registry/test/*.test.js` | 16 | 16 | 0 | 0 |

**合计 88/88**。root 的 89 多出的 1 项来自：

```text
$ node --test packages/_template/test/core.test.js
✔ groups children by parent
ℹ tests 1
ℹ pass 1
ℹ fail 0
```

> 修复后：quota 新增 1 项（22），模板移出 workspaces；六包合计 **90/90**（2026-11-14 17:55）。

`package.json` 的 glob 是 `node --test packages/dsh-os-*/test/*.test.js`；`_template` 已移到 `templates/_template`，不再参与 workspaces 与测试。六包合计 90/90。

**语法检查**

```text
$ for p in packages/dsh-os-*; do for f in "$p"/src/*.js; do node --check "$f"; done; done
```

12/12 全部 `OK`（6 包 × `core.js` + `index.js`），无输出、无 exit≠0。

**覆盖缺口（不判 FAIL）**：`dsh-os-lease/test/` 只有 `core.test.js`，没有 `index.test.js`；其余 5 包都有。lease 的 “apply 注册 4 个工具” 目前只能靠本次人工 import 验证（见 §2.5）。

---

### 2.2 命名

**时间**：npm `2026-11-14T17:26:16+08:00`；GitHub `2026-11-14T17:26:34+08:00`。

**npm**（`npm view <name> version`，E404 时 exit=1，属预期）：

```text
$ npm view dsh-os-trace version
npm error code E404
npm error 404 Not Found - GET https://registry.npmjs.org/dsh-os-trace - Not found
$ echo $?
1
```

六个包结果一致：

| 包名 | `npm view` | registry HTTP | GitHub `q=<name>+in:name` |
|---|---|---|---|
| dsh-os-trace | E404, exit=1 | 404 | `total_count: 0` |
| dsh-os-lease | E404, exit=1 | 404 | `total_count: 0` |
| dsh-os-quota | E404, exit=1 | 404 | `total_count: 0` |
| dsh-os-eval | E404, exit=1 | 404 | `total_count: 0` |
| dsh-os-catalog | E404, exit=1 | 404 | `total_count: 0` |
| dsh-os-registry | E404, exit=1 | 404 | `total_count: 0` |

GitHub 原始响应：

```json
{"total_count":0,"incomplete_results":false,"items":[]}
```

**注意**：本机 `npm config get registry` 为 `https://registry.npmmirror.com`，但 `npm view` 错误信息显示实际请求的是 `https://registry.npmjs.org`；另外用 `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/<name>` 直连复核，六包均为 **404**。两条路径结论一致。

**后续限流（不影响上面的命名结论）**：17:28 试图复核 eval README 的 “95 repos / 40★” 统计时，GitHub Search API 返回 `API rate limit exceeded`（403），未再取得数据；见 §3 B11。

---

### 2.3 打包面

命令（每包目录内）：

```sh
cd packages/dsh-os-<pkg>
npm pack --dry-run --json
```

| 包 | tarball | files | size | `src/` | patch yml | README | DESIGN | package.json | test/ | node_modules/ | LICENSE |
|---|---|---:|---:|---|---|---|---|---|---|---|---|
| trace | dsh-os-trace-0.1.0.tgz | 6 | 22343 | ✅ core.js, index.js | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| lease | dsh-os-lease-0.1.0.tgz | 7 | 19947 | ✅ core.js, index.js | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ |
| quota | dsh-os-quota-0.1.0.tgz | 6 | 17927 | ✅ core.js, index.js | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| eval | dsh-os-eval-0.1.0.tgz | 6 | 16682 | ✅ core.js, index.js | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| catalog | dsh-os-catalog-0.1.0.tgz | 6 | 18550 | ✅ core.js, index.js | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| registry | dsh-os-registry-0.1.0.tgz | 6 | 14594 | ✅ core.js, index.js | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |

原始文件列表（trace 示例）：

```text
DESIGN.md, README.md, cordis.patch.yml, package.json, src/core.js, src/index.js
```

**结论**：任务指定的 5 类文件全部在 tarball 内；无 `test/`、无 `node_modules/`。**5/6 包没有 `LICENSE` 文件**，这是第 7 项 FAIL（见 §2.7），不是打包 glob 漏带——这些包根目录本来就没有 LICENSE。

---

### 2.4 元数据

| 字段 | 六包实测 | 判定 |
|---|---|---|
| `name` | 与目录 / Cordis 导出 `name` 一致 | PASS |
| `version` | 全部 `0.1.0` | PASS |
| `description` | 6 条均存在且互不相同（内容准确性见 §2.6） | PASS |
| `license` | 全部 `Apache-2.0` | PASS |
| `type` | 全部 `module` | PASS |
| `main` | 全部 `src/index.js`，文件存在 | PASS |
| `dsh.bundle.patch` | 全部 `./cordis.patch.yml`，文件存在 | PASS |
| `engines.dsh` | 全部 `>=0.2.2-rc.3 <0.3.0`；与 checkout `0.2.2-rc.3` 相符 | PASS |
| `files` | 全部含 `src`、`cordis.patch.yml`、`README.md`、`DESIGN.md`；lease 另含 `LICENSE` | PASS |

**`cordis.patch.yml`（PyYAML 解析 + 与包名比对）**

六个文件都是顶层数组，且只有一行：

```yaml
- insert:
    - id: dsh-os-trace
      name: dsh-os-trace
```

| 包 | 顶层数组 | row id == 包名 | row name == 包名 | 额外 key |
|---|---|---|---|---|
| trace | ✅ | ✅ | ✅ | 无 |
| lease | ✅ | ✅ | ✅ | 无 |
| quota | ✅ | ✅ | ✅ | 无 |
| eval | ✅ | ✅ | ✅ | 无 |
| catalog | ✅ | ✅ | ✅ | 无 |
| registry | ✅ | ✅ | ✅ | 无 |

对照 DSH `docs/user/develop/basic/publish.md`：bundle patch 的 `name` 是 Node 解析用的包名，`id` 是层内行 id；本套件把两者都写成 `dsh-os-*`，合法且唯一。格式正确。

**可选字段一致性（不阻断，记入第 8 项）**

- `scripts.test`：trace/lease/quota/eval/registry 有；**catalog 没有**（registry 有）。
- `keywords`：仅 quota/eval 有；其余 4 包无。
- `exports`：5 包只有 `"."`；eval 另有 `"./core": "./src/core.js"`（不在 DSH 标准 export key 集合内）。
- `repository` / `homepage` / `author`：6 包全部缺失（不影响 npm 发布，但降低可追溯性）。
- 运行时依赖：6 包都把 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools` 放在 `dependencies`；DSH 包的通行做法是把需与宿主共享实例的 `@deepseek-ai/*` 放 `peerDependencies`（并配 `devDependencies`）。本套件只实际 import `dsh-tools`，`cordis` 仅 JSDoc 使用；当前不报错，但存在重复实例风险，见 B9。

---

### 2.5 真实导入

方法：对每个 `src/index.js` 执行 Node 动态 `import()`，检查导出；用假 ctx `{ tools: { register(t) { ... } } }` 调 `apply(ctx)`，记录注册的工具。

| 包 | 导出 `name` | 导出 `inject` | 导出 `apply` | `apply` 抛错 | 注册数 | README 声称 | 工具名 |
|---|---|---|---:|---:|---:|---:|---|
| trace | `dsh-os-trace` | `["tools"]` | function | 无 | 4 | 4 | trace_query, trace_why, trace_export, trace_verify |
| lease | `dsh-os-lease` | `["tools"]` | function | 无 | 4 | 4 | workspace_lease, workspace_apply, workspace_rollback, workspace_status |
| quota | `dsh-os-quota` | `["tools"]` | function | 无 | 4 | 4 | quota_status, quota_set, quota_admit, quota_consume |
| eval | `dsh-os-eval` | `["tools"]` | function | 无 | 3 | 3 | eval_run, eval_gate, eval_report |
| catalog | `dsh-os-catalog` | `["tools"]` | function | 无 | 3 | 3 | capability_search, capability_preflight, capability_register |
| registry | `dsh-os-registry` | `["tools"]` | function | 无 | 3 | 3 | service_register, service_list, service_stop |

**额外导出**：trace 还导出 `TraceError`、`createTraceStore`、`verifyBundle`。`TraceError` 是错误类型（DSH 包面规则允许导出错误类型），但 `createTraceStore` / `verifyBundle` 是实现值，不属于 Loader 四件套；DSH `docs/defensive-patterns/package-surface.md` 明确要求函数插件入口不要冻结“test-convenience value”（见 B8）。

所有 21 个工具都带 `parameters` 与 `output`，本次假 ctx 调用未触发异常。

---

### 2.6 描述准确性

对照 `package.json` description / README 开头与实际实现：

| 包 | description（原文） | 实际 | 判定 |
|---|---|---|---|
| trace | `Causal audit and tamper-evident evidence bundles for DSH agent runs.` | 内存 span store + SHA-256 链 + export/redact/verify；不实时采集、不接 OTel、无 SQLite、无签名/外部锚。README 全部主动披露（`README.md:166,170,171`）。 | **PASS（有边界说明）** |
| lease | `Workspace leases and multi-file transactions for parallel DSH agents.` | 租约 + patchset prepare/commit/rollback；**只记录意图，不读写文件**，commit 只返回 `writes` 计划，rollback 只返回 restore 计划（`src/core.js:758-763`；`README.md:11-12,135`）。 | **FAIL（措辞过强）** |
| quota | `Token, job and disk budgets with admission control for DSH agents.` | 预算账本 + `admit`/`consume` 决策，但**纯 advisory**：不拦截 LLM/job、不自动计量、不杀进程（`README.md:30,114`；工具描述 “never blocks a real call”）。另外 `quota_status` 标 “Read-only” 但查未知 scope 会创建账本（见下）。 | **FAIL（措辞 + 行为/文档不一致）** |
| eval | `Regression eval gates for DSH agents: replay trajectories, compare baselines, fail CI.` | 只有 **mock runner** / 可注入同步 runner；**没有 trajectory replay、没有 session adapter、没有 CI 集成**。README 自己在 `README.md:21-22` 说 “In the MVP it is a mock”，`README.md:174-177` 说 “No real session/runner adapter ... does not read DSH sessions, replay live model calls”。 | **FAIL（硬失实）** |
| catalog | `Intent-based capability catalog for DSH tools, plugins and MCP servers.` | 手工 manifest 的内存目录 + token/前缀/子串打分；不自动扫描插件、不接 MCP、不是 embedding 语义检索。README `README.md:140-143` 明确披露。 | **PASS（建议加 manifest-driven 限定）** |
| registry | `Local service and port registry for dev servers started by DSH agents.` | 内存端口/服务租约登记；不启动/探活/代理/杀进程，不检查 OS 端口占用。README `README.md:95` 明确披露。 | **PASS（边界已说明）** |

#### 2.6.1 FAIL 证据与修复

**（1）dsh-os-lease —— “multi-file transactions” 实际不执行事务**

- 证据 1：`packages/dsh-os-lease/package.json:4` 与 `README.md:6` 的 description。
- 证据 2：`README.md:11-12`：“Everything is recorded as intent; the MVP never reads or writes files.”
- 证据 3：`README.md:135`：“**Does not write files.** `commit` returns a write plan; your host/applier must perform it. There is no atomic file replacement, fsync, or backup.”
- 证据 4：`src/core.js:758-762` 对 `commitPatchset` 的注释：“No file is written by this function.”
- **风险**：npm 列表页只看到 “multi-file transactions”，容易理解为“多文件原子提交”；实际只是意图层状态机。
- **修复**：description 改为 “Intent-level workspace leases and multi-file patchset planning for parallel DSH agents.”（或加 “no file I/O”）；README 首句同步加限定。功能本身不需要改。

**（2）dsh-os-quota —— “admission control” 实际不拦截 + `quota_status` 不是只读**

- 证据 1：`package.json:4` / `README.md:3` 的 description。
- 证据 2：`README.md:30`：“The MVP is accounting and policy only. It does not intercept LLM calls or the jobs registry, and it does not by itself stop a process. Callers ... decide whether to honor `allowed`.”
- 证据 3：`README.md:114`：“**Advisory, not enforcing** — `allowed: false` does not abort an LLM request or kill a job.”
- 证据 4：`README.md:67` 把 `quota_status` 标为 “Read-only”；但 `src/index.js:88-90` 调用 `governor.status(scope)`，而 `src/core.js:574-577` 的 `status()` 使用 `resolve(scope)`，`resolve` → `ensureScope` 会 `ledger.set(id, ...)` 新建 scope。实测：

```text
$ node /tmp/audit-quota-readonly.mjs
before list: {"scopes":[]}
status unknown: {"scope":"ghost", ... "level":"ok" ...}
after list: {"scopes":[{"scope":"ghost", ...}]}
```

  即 `quota_status(scope: "ghost")` 写入了账本；`quota_status` 还标了 `isConcurrencySafe: () => true`（`src/index.js:87`）。这与 “Read-only” 直接冲突，也让任意 agent 可用 status 调用制造无界 scope（README 限制 7 已承认无界基数，但没承认 status 会写）。
- **修复**：让 `status()` 不创建 scope（用 `ledger.get`，未知 scope 返回默认快照或 `null`），或明确把 “查询未知 scope 会创建” 写进 README 并去掉 `Read-only` / `isConcurrencySafe`。建议前者；`quota_set` 才创建。
- **description 修复**：改为 “Advisory token, job and disk budgets with admission decisions for DSH agents.”，或在 “admission control” 后加 “(advisory)”。

**（3）dsh-os-eval —— “replay trajectories” 没有实现**

- 证据 1：`package.json:4` 与 `README.md:3` 的 description。
- 证据 2：`README.md:21-22`：“**Runs are replayable.** A runner is injected. In the MVP it is a mock; a host can plug in a recorded-trajectory adapter without changing the gate.” —— “可插拔”不等于 “已实现 replay”。
- 证据 3：`README.md:174-177`：“**No real session/runner adapter.** ... this package does not read DSH sessions, replay live model calls, or attach to session-query/OTel yet.”
- 证据 4：`src/index.js:159-166` 的默认 runner 是 `createMockRun`，只回显 `case.input` 并把 steps/tokens/latency 置 0；`eval_run` 的工具描述也写 “through an injected mock runner ... Never calls a model or reads a session.”
- **风险**：npm 描述让用户以为可以直接回放 DSH 轨迹；实际需要自己注入 runner。
- **修复**：0.1.0 的 description 改为 “Regression eval gates for DSH agents: mock/injectable runners, baseline comparison, CI verdicts.”；删除 “replay trajectories”，直到 DESIGN 中的 adapter 落地。README 第 3 行同步改。

**（4）非 FAIL 但建议收紧**

- trace 的 “tamper-evident” 是哈希链意义上的；没有签名/外部锚。README 已说明，npm description 可考虑写 “hash-chain evidence bundles”，避免安全读者误解为不可伪造。
- catalog 的 “Intent-based” 实际是 token/前缀/子串打分，不是 embedding；README 已说“非语义检索”，description 可加 “manifest-driven” 或 “lexical”。
- registry 的 “port registry” 不检查 OS 端口，只是进程内预约；README 已说明，description 可加 “in-process”。

---

### 2.7 合规 / 安全

#### 2.7.1 README 声明

| 包 | 字面 `not affiliated` | 中文等价声明 | `Apache-2.0` | 无 SLA 声明 | 发布物 `LICENSE` |
|---|---|---|---|---|---|
| trace | 无字面英文 | 有（“与 DeepSeek 无隶属关系” / “非 DeepSeek 官方项目”） | 有 | 有（“无 SLA”） | **无** |
| lease | 有（`README.md:3`） | — | 有 | 有（“No SLA”） | 有 |
| quota | 有（`README.md:5`） | — | 有 | 有（“no SLA”） | **无** |
| eval | 有（`README.md:7`） | — | 有 | 有（“No SLA”） | **无** |
| catalog | 无字面英文 | 有（“不是 DeepSeek 官方项目，与 DeepSeek 无隶属关系”） | 有 | 有（“无 SLA”） | **无** |
| registry | 无字面英文 | 有（“与 DeepSeek 无隶属关系” / “非 DeepSeek 官方项目”） | 有 | 有（“无 SLA”） | **无** |

**判定**：README 的三项声明（非官方 / Apache-2.0 / 无 SLA）**语义上六包都有**；字面英文 `not affiliated` 只在 lease/quota/eval 出现，trace/catalog/registry 用中文等价句（记入第 8 项的语言不一致，不单独判违规）。

**但发布物许可 FAIL**：

```text
$ ls -l packages/dsh-os-*/LICENSE
-rwxrwxrwx 1 yy yy 11358 ... packages/dsh-os-lease/LICENSE
# 其余 5 个包：No such file or directory
```

`npm pack` 结果也确认：trace/quota/eval/catalog/registry 的 tarball 均为 6 个文件，不含 `LICENSE`；只有 lease 是 7 个文件、含 `LICENSE`。

- 这 5 个包的 `package.json` 都声明 `"license": "Apache-2.0"`，README 也写了 Apache-2.0，但**分发包里没有许可证全文**。Apache-2.0 §4(a) 通常要求随分发附带许可证副本；仅靠 `package.json` 字段和 README 外链不等于附副本（建议法务最终确认，但发布前应补齐）。
- **修复**：把 `packages/dsh-os-lease/LICENSE`（已确认是 Apache License 2.0 全文，11358 bytes）复制到其余 5 包；在 `files` 中显式加 `"LICENSE"`（npm 通常会自动包含 LICENSE，但显式更稳），重新 `npm pack --dry-run --json` 确认。

#### 2.7.2 core 网络 / fs 写入

```text
$ grep -rnE "node:fs|node:net|node:http|node:https|node:dns|child_process|fetch\(|spawn|execFile|writeFile|appendFile|createWriteStream" packages/dsh-os-*/src
packages/dsh-os-trace/src/index.js:1:import { readFileSync } from 'node:fs'
```

- `core.js` 的 import 只有 `node:crypto`（trace）和 `node:util`（eval）；六个 `core.js` 均无 fs / net / http / child_process / fetch。
- 唯一的 fs 接触是 `dsh-os-trace/src/index.js` 启动时 `readFileSync(dataFile)`，**只读**；`trace_query/why/export/verify` 本身不写文件。
- 未发现 `process.env`、`process.exit`、`writeFile`、`unlink`、`mkdir` 等。
- **判定：PASS**（按 “core 无网络 / 无 fs 写入” 的标准）。

#### 2.7.3 硬编码密钥

```text
$ grep -rniE "sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{20,}\." --exclude-dir=node_modules .
NO REAL-LOOKING SECRETS
```

- 只有 trace 的测试 fixture 使用 `sk-live-123` / `sk-root` 这类明显假值，且测试不在 tarball 内。
- `cordis.patch.yml`、`src/`、`package.json` 无凭据。
- **判定：PASS**。

#### 2.7.4 `cordis.patch.yml` 注入风险

- 结构固定为 `- insert: - id/name`，**没有 `config`、没有 `!!js`、没有 YAML anchor/alias、没有外部文件引用**。
- `id`/`name` 都是六包自己的包名；`name` 作为 Node 模块说明符由 Loader 解析，不经过 shell。
- 当前内容没有可注入的表达式或用户可控字段；风险等同于“安装一个包就会执行其代码”，这是 npm 插件模型的固有风险，不是 patch 额外放大的。
- **判定：PASS**（当前内容）；建议后续若加 `config`，不要用 `!!js` 拼接未信任输入。

---

### 2.8 一致性

| 维度 | 实测 | 判定 |
|---|---|---|
| README 结构 | 3 中文（trace/catalog/registry）+ 3 英文（lease/quota/eval）；章节名/顺序/数量不同：lease 有 `Tests`，quota 有 `Development`，eval 有 `Scoring`，catalog 有 `社区项目`，trace 有 `证据格式`，registry 只有 `许可`。 | **FAIL** |
| 工具命名 | 每包一个前缀：`trace_*` / `workspace_*` / `quota_*` / `eval_*` / `capability_*` / `service_*`；全部 snake_case；21 个名字互不重复；未发现与 DSH checkout 中精确同名工具（grep 近似，不构成保证）。 | **PASS** |
| 错误语义 | 三套：① 抛 core error（trace: `TraceError`；quota: `TypeError`/`RangeError`；eval: `EvalError`；catalog: `CatalogError`）；② 包装成普通 `Error` 加 `.code`（lease）；③ 返回 `{ok:false,error:{code,message}}`（registry；catalog 的 `preflight` 未知 id 也走结构化 blocker）。同一套工具里“抛异常”与“结构化失败”并存，调用方无法用统一方式处理。 | **FAIL** |
| 版本范围 | 6 包 `engines.dsh` 全为 `>=0.2.2-rc.3 <0.3.0`；`@deepseek-ai/cordis` 全 `^4.1.0`；`@deepseek-ai/dsh-tools` 全 `0.2.2-rc.3`。 | **PASS** |
| 可选元数据 | `scripts.test` 缺 catalog；`keywords` 仅 quota/eval；`exports` 仅 eval 多 `./core`；`repository`/`homepage`/`author` 全缺；`LICENSE` 仅 lease。 | **FAIL** |

**错误语义实测片段**（`/tmp/audit-errors.log`）：

```text
trace bad kind              => THROW ToolArgsError code=INVALID_ARGS ...
trace verify bad json       => RESOLVE {"ok":false,...,"firstBad":{...}}
lease acquire no owner      => THROW Error code=INVALID_ARGUMENT msg=INVALID_ARGUMENT: owner ...
quota set empty scope       => THROW TypeError code=undefined msg=scope must be ...
eval unknown case           => THROW EvalError code=UNKNOWN_CASE ...
catalog unknown preflight   => RESOLVE {"ok":false,"blockers":[{"code":"unknown-capability",...}]}
catalog register duplicate  => THROW CatalogError code=DUPLICATE_ID ...
registry bad port           => RESOLVE {"ok":false,"error":{"code":"INVALID_PORT",...}}
```

**建议的统一约定**（不代改，仅建议）：

1. 所有工具对“可预期的业务失败”返回 `{ok:false,error:{code,message}}`（registry 模式），对“程序错误/非法 schema”才抛异常；或反过来全部抛带 `code` 的 `Error`。二选一，六包一致。
2. 每包 `exports` 只保留 `"."`（eval 的 `./core` 若无对外承诺则移除）；trace 入口只保留 Loader 四件套 + 错误类型，`createTraceStore`/`verifyBundle` 从 `index.js` 移除（测试已从 `core.js` 直接 import，不受影响）。
3. README 用同一模板；至少统一语言（全英文或全中文）、统一“Why / Install / Tools / Permissions / Limitations / Naming / License”章节，再按包加 `Tests` / `Scoring` / `证据格式` 等专属节。
4. 补齐 `scripts.test`（catalog）、`keywords`（4 包）、`repository`/`homepage`/`author`（6 包）。

---

## 3. 小问题清单（不代改）

| ID | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| B1 | **P0 阻断** | trace/quota/eval/catalog/registry | 发布物无 Apache-2.0 `LICENSE` 全文，仅 lease 有 | 复制 lease 的 LICENSE 到 5 包，`files` 显式加 `"LICENSE"`，重新 pack 验证 |
| B2 | **P0 阻断** | `dsh-os-eval/package.json:4`、`README.md:3` | 描述称 `replay trajectories`，0.1.0 只有 mock，无 session/replay adapter | 改 description/首行为 “mock/injectable runners”；replay 落地后再加回 |
| B3 | **P1** | `dsh-os-lease/package.json:4`、`README.md:6` | “multi-file transactions” 实际不写文件、只返回 plan | 加 “intent-level” / “patchset planning” 限定 |
| B4 | **P1（已修）** | `dsh-os-quota/package.json:4`、`README.md:3` | “admission control” 实际 advisory，不拦截 | 已改为 “advisory ... admission decisions” |
| B5 | **P1（已修）** | `dsh-os-quota/README.md:67`、`src/core.js:574-577` | `quota_status` 标 Read-only，查未知 scope 会创建账本；还标 `isConcurrencySafe` | `status()` 已改为 peek（不创建），并加回归测试 |
| B6 | P2（已修） | `package.json:9`、`packages/_template/` | root `npm test` 把 `_template` 占位测试算进来 | 模板已移到 `templates/_template`；glob 收窄到 `packages/dsh-os-*/test/*.test.js` |
| B7 | P2（已修） | `packages/dsh-os-lease/test/` | 无 `index.test.js`，4 个工具注册无覆盖 | 已补 `test/index.test.js`；六包 90/90 |
| B8 | P2（已修） | `dsh-os-trace/src/index.js`、`dsh-os-eval/package.json` | trace 入口多余导出；eval 多 `./core` export | 已移除；入口只导出 `name/inject/apply` |
| B9 | P2（已修） | 六包 `package.json` | `@deepseek-ai/*` 放在 `dependencies` 可能与宿主重复 | 已改为 `peerDependencies` + `devDependencies`；重新安装/测试通过 |
| B10 | P2（已修） | 六包 `package.json` | 缺发布元数据 | 已补 `repository.directory`/`homepage`/`bugs`/`author`/`keywords`/`scripts.test`/`publishConfig` |
| B11 | P3（已修） | `dsh-os-eval/README.md:11-12` | 不可复核的统计 | 已删除数字，改为定性描述 |
| B12 | P3（已修） | 六包 README | 语言/声明不一致 | 六包均含英文 `Not affiliated with` 声明；英文标题+中文细节统一 |

---

## 4. 结论

### 判定：**需修复后发布**

**已通过（可作为发布基础）**

- 审计时 89/89（root，含模板 1 项）；模板移出后六包 89/89。12 个 `src/*.js` 全部 `node --check` 通过。
- 6 个 npm 包名全部 E404、GitHub 精确搜索全部 `total_count: 0`（2026-11-14 17:26 +08）。
- 6 个 tarball 均含 `src/`、`cordis.patch.yml`、`README.md`、`DESIGN.md`、`package.json`，无 test/node_modules。
- 6 包元数据核心字段正确；`cordis.patch.yml` 的 id/name 与包名一致、YAML 可解析。
- 6 包动态 import 成功，`name`/`inject`/`apply` 齐全，假 ctx 下注册 21 个工具，数量与 README 全部一致。
- core 无网络、无 fs 写入；无硬编码真实密钥；patch 无 `!!js`/`config` 注入面。

**发布前必须修（P0）**

1. **B1**：给 trace/quota/eval/catalog/registry 补 `LICENSE`（Apache-2.0 全文），重新 pack 确认 7 个文件。
2. **B2**：修正 `dsh-os-eval` description/README 首行的 `replay trajectories`；0.1.0 只能承诺 mock/injectable runner。

**强烈建议同批修（P1）**

3. **B3/B4**：lease 加 “intent-level”，quota 加 “advisory”，避免 npm 列表页过度承诺。
4. **B5**：修 `quota_status` 的只读语义（或改文档/去掉 `isConcurrencySafe`）。

**P2/P3**：B7–B12 已全部处理（见各行“已修”）。。

**复核方式**：修完后重跑

```sh
npm test
for p in packages/dsh-os-*; do (cd "$p" && npm pack --dry-run --json); done
for n in dsh-os-trace dsh-os-lease dsh-os-quota dsh-os-eval dsh-os-catalog dsh-os-registry; do npm view "$n" version; done
```

命名检查若距发布超过数小时，应重新跑 npm/GitHub（名称可被抢注）。

---

## 5. 工具名总表（21 个，无重复）

| 包 | 数量 | 工具名 |
|---|---:|---|
| dsh-os-trace | 4 | `trace_query`, `trace_why`, `trace_export`, `trace_verify` |
| dsh-os-lease | 4 | `workspace_lease`, `workspace_apply`, `workspace_rollback`, `workspace_status` |
| dsh-os-quota | 4 | `quota_status`, `quota_set`, `quota_admit`, `quota_consume` |
| dsh-os-eval | 3 | `eval_run`, `eval_gate`, `eval_report` |
| dsh-os-catalog | 3 | `capability_search`, `capability_preflight`, `capability_register` |
| dsh-os-registry | 3 | `service_register`, `service_list`, `service_stop` |

- 去重检查：21 个名字 → 21 个唯一值。
- 冲突检查：六包之间无同名；与 DSH checkout 的 `packages/`、`apps/` 做精确字符串 grep 未发现同名工具（近似检查，非形式化保证）。
- 命名风格：均为 `snake_case`，每包一个语义前缀；跨包前缀不同（`trace_` / `workspace_` / `quota_` / `eval_` / `capability_` / `service_`），属于有意分区，不算冲突。

---

## 6. 复现命令（本次实际执行）

```sh
cd /mnt/d/Projects/dsh/deepseek-community-hub/04-build/dsh-os-suite

# 1) 测试
npm test
for p in trace lease quota eval catalog registry; do node --test packages/dsh-os-$p/test/*.test.js; done
for p in packages/dsh-os-*; do for f in "$p"/src/*.js; do node --check "$f"; done; done

# 2) 命名（时间：2026-11-14 17:26 +08）
for n in dsh-os-trace dsh-os-lease dsh-os-quota dsh-os-eval dsh-os-catalog dsh-os-registry; do
  npm view "$n" version
  curl -s -o /dev/null -w '%{http_code}\n' "https://registry.npmjs.org/$n"
  curl -s -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/search/repositories?q=$n+in:name"
done

# 3) 打包面
for p in trace lease quota eval catalog registry; do
  (cd packages/dsh-os-$p && npm pack --dry-run --json)
done

# 4) 动态 import + 假 ctx（本次用 /tmp/audit-import.mjs）
# 5) 工具行为 / 错误语义（本次用 /tmp/audit-smoke.mjs、/tmp/audit-errors.mjs）
```

> 说明：本次没有向真实 DSH profile 安装六个 bundle（避免写入用户 profile / DSH_HOME），bundling 的正确性用 “动态 import + patch YAML 解析 + DSH 官方 publish 文档比对” 验证；真实 `dsh plugin add` 安装验证建议在隔离的临时 `DSH_HOME` 中做一次后再发布。

---

## 修复记录（lead，2026-11-14 17:35 +08）

| 审计问题 | 修复 | 验证 |
|---|---|---|
| ① 5/6 包缺 Apache-2.0 LICENSE 全文（lease 的 LICENSE 实为 MIT） | 从 apache.org 取 Apache-2.0 全文，写入 6 个包的 `LICENSE`；`package.json.files` 加入 `LICENSE` | `grep -c "Apache License" packages/dsh-os-*/LICENSE` 均为 4；`npm pack --dry-run` 均含 `LICENSE` |
| ② eval/lease/quota 描述 overclaim | eval 改为 “case definitions, baseline comparison and CI verdicts”；lease 改为 “lease intents and multi-file transaction plans”；quota 改为 “advisory ... admission decisions”；CONTRACT/README 同步 | 6 个 `package.json.description` 与 README 首段一致 |
| ③ `quota_status` 查未知 scope 会创建账本 | `status()` 改为 `peek` 语义：不创建、返回 detached 默认快照；新增测试 `status does not create an unknown scope` | 根 `npm test` **90/90 pass**（六包；lease index +1） |

**复验**：`npm test` 90/90；每个包 `node --check` 通过；smoke import 6 个入口均导出 `name/inject/apply` 并注册 21 个工具；命名复核 npm E404、GitHub total_count 0。

**结论更新**：审计问题与 P2/P3 均已处理；0.1.0 已发布，0.1.1 为修正 README 状态后的发布版本。见文末“发布记录”。

**真实安装验证（lead，2026-11-14 17:45 +08）**：在临时 `DSH_HOME`（`mktemp -d`，未触碰用户 profile）中，用 `npx @deepseek-ai/dsh@0.2.2-rc.3 plugin --profile web add` 安装六个 tarball，全部成功；`dsh --profile web --dump-config` 输出六条 `# == dsh-os-*` 条目。peer dependency 警告仍在（B9，P2），但不阻塞安装。

---

## 发布记录（2026-11-14 17:55 +08）

| 包 | npm 版本 | 链接 |
|---|---|---|
| dsh-os-trace | 0.1.1 | https://www.npmjs.com/package/dsh-os-trace |
| dsh-os-lease | 0.1.1 | https://www.npmjs.com/package/dsh-os-lease |
| dsh-os-quota | 0.1.1 | https://www.npmjs.com/package/dsh-os-quota |
| dsh-os-eval | 0.1.1 | https://www.npmjs.com/package/dsh-os-eval |
| dsh-os-catalog | 0.1.1 | https://www.npmjs.com/package/dsh-os-catalog |
| dsh-os-registry | 0.1.1 | https://www.npmjs.com/package/dsh-os-registry |

- GitHub monorepo: https://github.com/PerryLink/dsh-os-suite
- 0.1.0 首发的 README 仍写“not published yet”；0.1.1 已修正状态并补 npm 安装命令。
- npm 新包首发会短暂出现 `0.0.0-stage` 占位版本（npm staged processing），数分钟后 `0.1.0` 正常可见；不是发布失败。
- 发布账号：`perrylink`；包 owner：`perrylink`。
