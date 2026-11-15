# 复用来源

本插件使用官方 `@agentclientprotocol/sdk` 2.6.0 和 `@bufbuild/protobuf` 2.16.0；它们的许可证随各 npm 包提供。

Pi 会话、工具循环、会话树、压缩及历史转换来自宿主公开 API，不在插件内复制其执行框架。`src/pi-compat.ts` 只绕过 Pi 1.5.2 Jiti 对公开 `pi-ai/api/transform-messages` 子路径的前缀别名问题。

本机既有 `plugin.antigravity-native` 1.2.15 的工具桥、名称映射、输出裁切、模型能力、进程清理和进程级网络监控接线被最小冻结复用；源路径和提取边界见 `frozen-sources.json`；该清单只记录来源，不作文件一致性准入。新桥删除了旧的自动超时放行，不含 ACK 预填或旧会话文本重建。

`resources/history-schema.json` 保存原生局部 protobuf 字段和原生公共持久化 AES 格式常量（不是账号凭据）；不保存 exe 身份、准入版本或密钥偏移。它不承诺未来原生格式永不变化，真实加载失败由原生错误报告。SQLite 跨目录快照直接复用 Node `node:sqlite.backup`，不解释或改写原生数据表。
