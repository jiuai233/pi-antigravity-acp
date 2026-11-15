# 开发接手书 · ACP 0.1.11

目标：没有原机器、聊天记录或 pi-stack 控制面也能继续开发 ACP provider。先读[在线诊断禁忌](docs/safety.md)，默认离线验收。封包来源与实测结果见 [VERIFICATION.md](VERIFICATION.md)。

## 基线与兼容性

- 目标 ACP 0.1.11；实际源码版本、来源提交和完整文件指纹由 stage 从已提交插件写入 SOURCE.json，不沿用旧包文件数或测试数。
- Node.js 24；旧验证环境为 24.12.0。使用 SQLite backup、类型剥离和现代模块 API，不建议降到 Node 22。
- Pi SDK 基线 1.5.2；`host-reference/overlay` 是原已验证宿主相对官方同版 npm 包的既有开发兼容差异，非任意版本补丁，**不是 0.1.11 重试修复**。
- ACP SDK 2.6.0、Buf 2.16.0、Zod 3.25.76 为当前锁定运行依赖；stage 后附于 plugin/node_modules。宿主 Pi、开发工具和 agy.exe 不作为生产依赖携带。
- package.json、unit.json 和锁文件根版本均为 0.1.11；本轮只同步版本元数据，依赖解析结果不变。依赖闭包按随包锁文件安装。
- 独立摘要 requestIdentity、onPayload 等是既有宿主接缝，保留 host-reference/patches 供审阅。原版 Pi 1.5.2 与已适配同版不能混称。
- 本轮只改插件统一错误出口，不新增宿主或全局设置修改。依赖 Pi 1.5.2 当前文案分类，升级后重跑 [错误恢复说明](docs/error-recovery.md) 的离线兼容矩阵。

## 在独立副本准备开发环境

在已完成 stage／seal 的包根运行（获取公开开发依赖需要联网，但不请求 AGY／Google）：

```sh
python -B scripts/verify.py
cd plugin
npm ci --ignore-scripts --no-audit --no-fund
npm install --no-save --package-lock=false --ignore-scripts --no-audit --no-fund --legacy-peer-deps=false @earendil-works/pi-ai@1.5.2 @earendil-works/pi-agent-core@1.5.2 @earendil-works/pi-coding-agent@1.5.2
cd ..
python -B scripts/apply-host.py
cd plugin
npm test
npm run typecheck
cd ..
node scripts/smoke-sdk.mjs
python -B evidence/keepalive/analyze.py
```

`.npmrc` 的 legacy-peer-deps=true 会使仅 npm ci 或未覆盖选项的宿主安装漏 peer。第二条命令显式使用 `--legacy-peer-deps=false` 并固定三个宿主版本，不改 package.json／锁文件；这是旧包独立安装中发现并修正的问题。

apply-host.py 只处理本包 plugin/node_modules：先核对全部目标版本及基底／结果哈希，再复制既有兼容文件，不改全局 Pi。再次 npm ci 会清掉宿主和 overlay，应重做第二条安装及兼容应用；这不是重新启用重试修复。

npm test 从新包 plugin 目录运行已打包的全部测试，包括实际存在的 SDK／QuickJS Codemode 用例；具体数量由本次运行产生，不沿用旧包 128。假 ACP、本地回环、合成历史不启动真实 AGY、不用账号；SDK 初始化使用 `refreshOnCreate:false`，避免公开目录刷新。smoke-sdk 只验证扩展注册与命令，不发 prompt、不给出服务端可用性结论。

## 显式运行与维护命令

仅在自己的 AGY 已安装、已登录且获准正常使用后，于独立副本 plugin 目录执行：

```sh
node node_modules/@earendil-works/pi-coding-agent/dist/cli.js -e ./index.ts
```

选择 Antigravity ACP 分组，不覆盖既有 antigravity provider。持久安装按目标宿主的本地包方式另行处理；不复制 overlay 到正在运行的全局 Pi，不擅自改变默认模型或 packages。

`AGY_BINARY` 指定自己的 exe；`AGY_ACP_STATE_DIR` 指定独立状态目录。

| 命令／能力 | 边界 |
| --- | --- |
| `/agy-acp` | 当前会话、模型与检查点 |
| `/agy-acp doctor` | 本地绑定、运行状态、设置和目录诊断，不发模型请求 |
| `/agy-acp reset` | 停止当前执行、清除原生绑定，保留 Pi 聊天；持久标记使重开后不恢复旧检查点；下一输入不自动回灌 reset 前全部历史 |
| `/agy-acp models` | 通过 agy models 手动刷新目录，不发生成请求；失败保留上次成功目录并报告错误，不当作反复轮询健康检查 |
| 成功模型缓存 | agent 目录保存成功目录，启动先用缓存或内置目录；选中 ACP 按有效期刷新，普通非 ACP 会话不为此启动 AGY |
| 错误检查点 | 当前原生错误不推进已接受步骤；旧错误不误判当前成功，不回退此项保护 |

## 从哪里改

- 历史／压缩／恢复：plugin/src/history.ts、store.ts、runtime.ts，配套 history、store、runtime 测试。
- MCP／长工具／动态激活：src/bridge/、profile.ts，配套 bridge、profile、codemode-bridge。
- 原生通知／公开思考／展示：runtime.ts、native-tools.ts、message-writer.ts。
- 本轮终态策略：统一 message-writer 失败出口与 runtime 来源分类，覆盖普通流及独立摘要直调；不是只修改 message_end。职责、错误矩阵、原生重试已知与未知见 docs/error-recovery.md。
- 模型／档位与目录缓存：models.ts、platform.ts、入口命令和 runtime 配置。
- 计量／额度：usage.ts、quota.ts；认证成功、目录可读、额度可读不等于生成成功，额度查询不是免费离线操作。
- Pi Web：host-reference/piweb 为独立分支片段，不是完整应用；移植链路见 docs/architecture.md。
- 窗口／保活：references/binary-patches 与 docs/binary-patches.md；跨版本不混用，不默认启用。

首次接手运行全插件离线基线；以后沿差异及直接调用方选择测试，不重放旧在线实验。

## 错误与恢复

AGY 1.5.9 已有临时 429／5xx／网络内部重试；日／账单额度及已识别超过 30 秒的服务端限流等待有停止分支。次数依配置，旧 attempt 1..5 不是固定五次，没有完整公开控制参数。本包不另造重试引擎。

确定的原生终态提供稳定失败摘要，完整原文保存在同条正文和 diagnostics，stopReason 仍为 error；Pi 不重启整轮，已完成工具不重执。上下文超限、用户取消和通信断开保持原路径，其他 provider 不受影响。不要用统一 catch 将任意异常伪装成原生终态。

Pi 树是权威，原生状态是执行记录与加速手段；没有准确接受边界时不盲 load 尾部。reset 是显式丢弃绑定，不是自动失败重试。不可把随包冻结历史证据恢复为自己的活动会话。

源码已改、离线通过、安装成功、存活宿主已采用、真实服务成功是不同结果。缺服务证据就记录缺口，不靠反复请求补齐。Web 参考不含其他线程 WIP，二进制配方是否未提交由 SOURCE.json 记录，旧 native 桥不是 ACP 依赖。

## 维护者打包入口

此节仅适用于持有原 pi-stack 源仓与打包输入的维护者，接收方开发不依赖该仓。先完成插件与测试、提交本任务源码恢复点；stage 会拒绝相对 HEAD 有差异的插件目录。将下列路径换成真实输入，不能借旧包版本号拼来源：

```sh
python -B tools/share/agy_acp.py stage --out outputs/deliverables/agy-acp-kit-0.1.11-20261115 --host-node-modules <installed-Pi-node_modules> --stock <official-Pi-1.5.2-tgz-directory> --licenses <approved-license-directory>
```

stage 可向已有文档目录补入源码，但已有 plugin/ 时拒绝覆盖。SOURCE.plugin_version 来自本次实际 plugin/package.json；seal 的 manifest.plugin_version 来自已 stage SOURCE.json，与之后仓内版本无关。核对 SOURCE、全部文档、源码版本与离线实测并回填 VERIFICATION 后再封包：

```sh
python -B tools/share/agy_acp.py seal --out outputs/deliverables/agy-acp-kit-0.1.11-20261115
```

随后在独立解压副本核对 manifest／ZIP CRC／源文件指纹、安装依赖、类型、全套测试和 SDK 装载。解压验证日志在原包内记录时需重新 seal；不要改完文档留下陈旧哈希。旧 0.1.9 候选保留不动。
