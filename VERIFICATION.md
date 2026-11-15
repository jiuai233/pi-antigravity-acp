# ACP 0.1.11 交接包验证

2026-11-15（UTC+8）。Node.js 24.12.0、Pi SDK 1.5.2；源码恢复点 `9f371e7b`。源码与独立解压副本均通过 **156 项离线测试**，失败／取消／跳过均为 0，TypeScript 通过。真实 Pi SDK 装载注册 8 个 ACP 模型和 `agy-acp` 命令，加载错误为 0，未调用模型 prompt、未创建原生状态。

## 对象与实际运行

完整 53 份插件开发文件、20 份测试及固定的 ACP SDK 2.6.0、Buf 2.16.0、Zod 3.25.76 运行依赖由 SOURCE.json 逐文件指纹记录。锁文件仅同步根版本到 0.1.11，依赖解析未改变。既有 31 文件 Pi 1.5.2 兼容 overlay 保留为独立开发副本参考，本轮重试修改未改宿主。

源码工作目录为 `plugins/antigravity-acp/`；独立副本工作目录为 ZIP 解压得到的 `agy-acp-kit/plugin/`。依赖安装和全部命令按 AGENT-HANDOFF.md 执行：

| 项目 | 结果与日志 |
| --- | --- |
| 源码 `npm test` | 156/156；`verification/source/all-tests.log` |
| 源码 `npm run typecheck` | 退出 0；`verification/source/typecheck.log` |
| 解压副本 `npm ci --ignore-scripts --no-audit --no-fund` | 退出 0；`verification/recovered/npm-ci.log` |
| 固定三个 Pi 1.5.2 peer 的显式安装，含 `--legacy-peer-deps=false` | 退出 0；`verification/recovered/npm-host-install.log` |
| 包根 `python -B scripts/apply-host.py` | 退出 0；只恢复解压副本的既有开发基线；`verification/recovered/apply-host.log` |
| 解压副本 `PI_OFFLINE=1 npm test` | 156/156，0 失败／跳过；`verification/recovered/offline-tests.log` |
| 解压副本 `npm run typecheck` | 退出 0；`verification/recovered/typecheck.log` |
| 包根 `PI_OFFLINE=1 node scripts/smoke-sdk.mjs` | 8 模型、1 命令、0 加载错误、0 prompt、0 原生状态；`verification/recovered/sdk-smoke.log` |
| 包根 `python -B evidence/keepalive/analyze.py` | 退出 0，逐字段匹配冻结分析；`verification/recovered/keepalive-replay.log` |
| ZIP CRC、根清单、53 份源码 SHA256 | 独立解压核对通过；最终清单与 ZIP 哈希分别见 manifest.json 和 ZIP 外 `.sha256` |

首次新增摘要测试把 `retryAssistantCall` 的返回值误读为 `result.message`，10 项通过、1 项测试断言失败；按真实 API 返回的 AssistantMessage 修正为 `result.stopReason` 后，全套通过。初次失败保存在 `verification/source/retry-initial-failure.log`，未为迎合断言更改业务实现。

## 本轮错误恢复覆盖

- 400 参数错误（含 timeout）、403 账号错误（含 terminated）、日额度 429、原生恢复结束后的 503：保持 `error`，原始错误通过正文与诊断完整读回，事件正常收尾。
- 实际 SDK：外层重试预算设为 2 时，确定的原生终态只调用一次；ACP 通信错误与其他 provider 仍调用三次。正式插件沿用原生重试，没有第二套引擎。
- 已完成工具只执行一次；失败后用户明确提交下一轮仍可成功。原生错误不推进接受检查点，历史及当轮已恢复错误不污染成功。
- 取消仍为 aborted；上下文超限保持原始错误与宿主识别。本轮验证分类保留，不声称执行了真实超限后的在线压缩。
- 摘要使用的 `retryAssistantCall` 直接消费 provider 结果也只调用一次，不依赖 `message_end` 钩子。内部摘要失败的 UI 呈现由 Pi 摘要调用方决定，不伪造主会话消息。
- 原生内部重试规则来自 AGY 1.5.9 官方记录和只读二进制分析，见 `evidence/native-retry/findings.json` 及对应 `.asm`。本轮没有用真实账号重放错误。

`verification/source/result.json` 保存本机宿主重试、会话、设置文件及用户重试设置的前后 SHA256 对照，均未改变。生产插件未安装切换。

## 保活与分发边界

五条历史请求输入 273956、缓存 0、输出 87、思考 135；唯一完整首针仍零缓存，无第二针，600 秒真实请求仍零缓存。未建立热缓存基线，不能据此声称保活有效；本轮只复算历史数据，不启用配方或复跑在线实验。

包内不包含 AGY exe、认证、会话数据库、完整私人提示词或观察器启动脚本。官方依赖中的公开示例不当作账号凭据。Web 文件来自独立已提交参考分支，不包含其他线程工作区改动，也不作为完整可运行 Web 应用交付。

用户要求不反复打 AGY／Google 真实接口或转发端口、不新搭正向 TLS 抓包代理。请求频率与代理指纹是重点封号怀疑，不写成已证实因果。
