# API Key / Secret 泄漏安全检查报告

> 历史记录：仅反映文中所述检查或调研时点，不代表当前功能、缺陷或验证状态。当前入口见[文档索引](../README.md)。

- 检查时间：2026-09-04
- 检查对象：`deepseek-harness-desktop` 仓库（含工作树、全部 git 历史、未跟踪文件、悬空对象、submodule `upstream`）
- 检查范围：API key / secret key / 私钥 / 高熵凭据的泄漏
- 结论：**未发现真实密钥泄漏**（唯一命中为测试占位符与架构设计引用）

## 执行摘要

对 76 个提交的全部历史树、当前工作树（tracked + untracked + 被忽略本地目录）、对象库悬空对象、GitHub CI 配置、以及 `upstream` 子模块逐一做了模式扫描与人工核查。**未发现任何真实的 API key、Secret Key、私钥或带凭据的 URL**。发现数处测试 mock 占位值与一处架构性「凭据引用名」设计，均不构成泄漏，详见下文。

## 检查方法

| 维度 | 手段 |
|---|---|
| 当前工作树（tracked） | `git grep` 多模式扫描 |
| 未跟踪新文件 | 逐个文件内容扫描（application-menu / windows-appearance / menu-model 等 10 个新文件） |
| 全部 git 历史 | `git grep` 对 `git rev-list --all`（76 个提交）做全树内容扫描 |
| 悬空对象 / reflog | `git fsck --full`，逐个检视 2 个 dangling commit、2 个 dangling blob |
| 敏感文件形态 | `find` 全工作树扫 `.env`、`*.pem`、`*.key`、`id_rsa`、`*.p12`、credentials 等 |
| CI 配置 | `.github/workflows/{ci,release}.yml` 的 secrets/env 使用核查 |
| 本地忽略目录 | `.zcode/`、`.dsh-home-dev/`、`.ci-artifacts/` 内日志/配置扫描 |
| submodule | `upstream` 工作树与历史抽查 |

### 扫描模式清单

- 私钥头：`-----BEGIN (RSA|EC|OPENSSH|DSA|PGP|ENCRYPTED) PRIVATE KEY-----`
- OpenAI：`sk-[A-Za-z0-9]{20,}`、`sk-proj-`、`sk-ant-`、`sk-live-`
- AWS：`AKIA[0-9A-Z]{16}`、`ASIA…`
- GitHub：`ghp_/gho_/ghu_/ghs_/ghr_`、`github_pat_`
- Google：`AIza[0-9A-Za-z_-]{35}`、`ya29.…`
- Slack `xox[baprs]-`、Stripe `sk/pk_live/test`
- 通用赋值：`(api_key|client_secret|access_key|token|password|secret)= 'xxx…'`
- URI 内嵌凭据：`scheme://user:pass@host`
- 高熵 40+ hex、32+ base64 串
- 提交信息、lockfile 的 `_authToken`、stash 列表

## 结果

### 无泄漏项

| 检查面 | 结果 |
|---|---|
| 全历史 76 个提交内容 | 无任何私钥 / 云厂商密钥 / 高熵凭据命中 |
| 历史文件清单（567 个） | 无 `.env`、`*.pem`、`id_rsa` 等敏感命名文件 |
| 当前 tracked 工作树 | 无命中 |
| 未跟踪新文件（10 个） | 仅键盘事件 `event.key` 等正常代码，无密钥 |
| 悬空对象 | 2 个悬空 commit、2 个悬空 blob 均为 electron-builder 配置 / CI workflow / 工程文件，无密钥 |
| GitHub CI（ci.yml / release.yml） | 仅用 `github.token`（自动注入、作用域限于当前仓库），**未引用任何 `secrets.*`**，即 CI 不持有自定义密钥 |
| lockfile / vendor | 无 `_authToken`、无带凭据 registry URL；`vendor/` 仅入库 `pnpm-lock.yaml` |
| 本地忽略目录（`.zcode` 等） | 无命中（且均被 .gitignore 覆盖，不入库） |
| git remote / config | 均为公开 HTTPS 仓库 URL，无凭据内嵌 |

### 命中项（均不构成泄漏）

1. **测试占位符**（位于 `upstream` 子模块测试代码）
   - `upstream/packages/client/ui-settings-models/tests/components.client.spec.tsx`：`sk-live`、`sk-ant` 等作为**测试输入值**（如行 352/354/923），非真实密钥
   - `upstream/packages/credentials/credentials-local/tests/local.spec.ts` 行 287：`sk-live-DO-NOT-LOG-abcdef123456`，明示"勿记录"的 mock 值
   - `upstream/examples/headless-agent/credentials.cordis.snapshot.yml`：keyless 首启示例，显式不含任何 API key
   - 均为上游自带测试/示例，非本项目引入；无真实值。

2. **架构性凭据引用名**（本项目代码，正确设计）
   - `packages/plugins/vision/`：API key 通过 credentials service 以**引用名**（如 `DSH_VISION_API_KEY`）管理，密钥本身不写入 settings、不进代码库；README（`vision/README.md`）明示「API key 通过 credentials service 管理，永远不会写入普通 settings」。这是推荐做法，非泄漏。
   - `apps/desktop/src/main/{index.ts,orphan-reaper.ts}`、`paths.ts`、`docs/architecture.md` 中提到 "API key" 均为说明 ~/.dsh 数据归属的注释/文档。

### 观察建议（非泄漏，供参考）

- `.gitignore` 覆盖良好：`.env` 虽未显式列出，但历史中从未出现过任何 `.env` 文件；本地开发数据目录（`.zcode/`、`.dsh-home-dev/`、`.ci-artifacts/`、`.tmp-video/`）均已忽略。
- `upstream` 子模块工作树当前有 48 个文件的**本地改动**（对应 `patches/` 补丁套用后的状态），`git submodule status` 显示干净 gitlink，无密钥相关改动；若担心，可 `git -C upstream diff` 复核（本次已扫描其 diff，无密钥命中）。
- 默认 `.gitignore` 未包含 `.env*` 与 `*.pem` 的兜底条目。虽然当前无泄漏，**建议补上** `*.env` / `.env*` / `*.pem` / `*.key` / `*.p12` 等模式作为防未来误提交的保险。

## 建议行动（可选）

1. （推荐，低风险）在 `.gitignore` 增加通用敏感文件模式兜底：
   ```
   .env
   .env.*
   *.pem
   *.key
   !patches/*.patch
   *.p12
   *.pfx
   ```
   （注意 `*.key` 需配合 `!patches/*.patch` 一类的例外，避免误伤 patch 中的文件名引用。）

2. 如仓库将推送公开，可考虑运行 `gitleaks` / `trufflehog` 做一轮独立工具复核（本报告已做等价手工扫描）。

3. 本地 `~/.dsh` 真实 API key 位于仓库外（`$DSH_HOME` 默认），不在本仓库任何位置，无需处理。
