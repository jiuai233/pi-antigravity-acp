# 证据索引与状态

本包保留可安全分发的原件／明确标注的公开子集，不携带完整账号日志、会话数据库和个人系统提示。

## 随包可核对

- evidence/keepalive/wire-analysis.json、network-events.jsonl、manifest.json：原安全记录逐字节复制；analyze.py改为相对路径、仅冻结输入及stdout比较，不覆盖原件；probe-result.json仅保留复算所需字段。这些变换登记在SOURCE.json。
- evidence/keepalive/keepalive-bytes.json及两个.asm：历史1.5.7只读字节／路径证据，不能作其他版本偏移。
- evidence/prompt-identity/两份summary：归档中的两轮次序对照原件。
- evidence/prompt-identity/native-identity-73-tools.json：原结果的公开答案、用量和设置子集，不含原始通知／个人提示。
- compile-summary.json：1.5.9原生agent编译结果，73个Schema、保留身份与Codemode完整契约；零生成验证。
- SOURCE.json：源提交／每份plugin文件SHA、宿主适配、Web参考提交及未提交配方快照来源。
- VERIFICATION.md：本次解压后离线验证，不替代历史在线记录。

## 原工程历史索引（不是包内文件）

原工程为 pi-stack。以下仅作为未来取得原仓权限时的定位信息，本包开发不依赖其绝对路径：
- notes/verify/agy-acp-plugin-final-20261113.md：早期0.1.0成品验收，含真实SDK、历史媒体、压缩、190秒长工具和Fork/Revert；长工具当时采用过渡恢复机制，不代表当前超时策略。
- notes/verify/agy-acp-parallel-trial-20261113.md：并排安装与Web入口。
- notes/verify/agy-acp-reuse-policy-20261113.md：修改前hash、降档及缺步骤恢复反例；不是当前版本未修复清单。
- notes/verify/agy-acp-prompt-diet-20261114.md：0.1.9身份提示与128项历史离线验证。
- notes/verify/agy-account-restriction-summary-20261114.md：403停用／VALIDATION_REQUIRED分离；无具体封禁判因。
- notes/verify/agy-keepalive-shadow-20261113.md及sol复核：保活单变量实验；只验证实验记录，不支持热续期成功。

完整实验归档和作者状态未直接分发。缺某条原始live证据时如实说明，不能为补齐交接而反复请求真实服务。


## 0.1.11 证据边界

旧包 0.1.9 的 128 项测试、46 份源码和历史真实生成属于旧对象，不作为本包测试数或源文件数。当前来源与数量见 SOURCE.json 和 manifest.json；本包 53 份源码指纹、156 项测试、类型、SDK 装载与独立解压复验结果见 VERIFICATION.md 及 verification/source、verification/recovered。

本轮纯插件方案有 Pi SDK 1.5.2 离线预研：原生 503 原样暴露时触发宿主重试；provider 稳定摘要并保留原文可阻止叠加，单靠终态标记无效；摘要直调同样需要 provider 出口。这是方案证据，不是最终插件验收。预研含其他 provider、传输、超限、取消及新用户回合反例；原件位于原工程 tmp/agy-acp-no-host-20261115/result.json，未作为包内文件分发。

AGY 1.5.9 官方说明与只读二进制分析支持其内部已具临时 429／5xx／网络恢复、日／账单额度及已识别超过 30 秒限流等待的停止分支。官方摘录、二进制指纹与阈值证据见 evidence/native-retry/findings.json 和同目录 .asm；未重新联网调用 AGY 验证，完整公开重试控制参数仍未知。使用边界与离线验收矩阵见 [error-recovery.md](error-recovery.md)。
