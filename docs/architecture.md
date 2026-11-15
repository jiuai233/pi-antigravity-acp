# 架构与文件职责

## 两套状态，两个执行边界

Pi 掌管用户历史、会话树、压缩和真实工具执行；ACP 掌管 AGY 的原生会话与生成。普通循环为：

`Pi streamSimple → AcpRuntime → ACP prompt → call_mcp_tool → loopback MCP bridge → Pi toolCall → Pi runner → 真实 toolResult → 同一 ACP prompt 继续`

MCP 桥只转发，不私自执行工具，不预填 ACK／成功。原生 read_file 则由 AGY 执行，通知只产生 pi-native-tool 展示元数据，不转成另一次 Pi 执行。

## 文件地图

| 文件／目录（plugin 内） | 职责 |
| --- | --- |
| index.ts | provider 注册、事件、摘要 runtime 隔离、绑定／展示记录和 /agy-acp 命令 |
| src/runtime.ts | owner 交接、暖续接、配置、冷导入、检查点与生命周期 |
| src/acp.ts | 官方 ACP SDK facade、进程与取消结算 |
| src/profile.ts | 原生 identity、私有 agent、完整工具说明、私有 MCP 配置／Schema |
| src/bridge/ | 工具别名、MCP 等待、真实结果配对、输出归档／裁切 |
| src/history.ts、resources/history-schema.json | Pi 有效历史到原生 protobuf/AES 持久化；不是凭据抽取 |
| src/store.ts | SQLite 在线 backup／protobuf 原样复制，保护旧分支 |
| src/native.ts | 原生控制接口、轨迹、Fork/Revert 与额度 |
| src/native-tools.ts、message-writer.ts | 原生读取展示去重；文字／公开思考事件 |
| src/usage.ts | inference 差分计费与最后一代水位，未知值显式保留 |
| src/quota.ts | 优先复用 live ACP 的原生额度接口，必要时冷 seed；不是免费无网络查询 |
| src/models.ts、platform.ts | 模型目录、名称／档位映射和 exe 定位 |
| src/network-monitor.ts | 历史可选观察器环境接线，保留源码但本包不启用观察器 |
| src/pi-compat.ts | 绕过 Pi 1.5.2 Jiti 对公开子路径的别名问题 |

## 复用判据

历史是否一致、模型／档位能否生效、传输环境是否需换进程分别判断。不要用一个混合 hash 把任何小改动都变成全量冷导入。

- 同一工具等待：新 owner 先处理配置，再只释放一次真实结果；动态发现更新 live 桥和 Schema，下一空闲回合更新 agent 快照。
- 重开／树导航：在 Pi 选定分支上找检查点。存在准确原生步骤时新 UUID Fork/Revert；缺游标或尾部覆盖不足时导入当前有效 Pi 历史。
- 系统／工具输入真正变化：重新编译原生 metadata 并重接 MCP，不能只改文件就声称旧会话已经采用。
- 摘要：独立 runtime，主原生会话不被摘要改写；之后导入 Pi 压后投影。
- 传输改变：更换必要进程，历史恢复按有效边界，不把代理变化和历史变化混为一谈。

## Pi Web 参考怎么用

host-reference/piweb 来自 SOURCE.json 指定的独立分支提交；不是主工作区的混合未提交快照，也不是完整应用。包括 NativeToolCard、native-tool-activity、MessageView/ChatWindow、wire／streaming／reader／types 和 rpc-manager 接缝。

移植时保持完整链路：appendEntry(pi-native-tool) → wire 传输 → 原生工具状态按调用 ID 合并 → streaming 与历史 reader → 工具卡展示。刷新后应仍只有一条只读活动，不能生成模型消息或 Pi 可执行 toolCall。Web 的组件、i18n、样式和消息类型要接目标应用已有实现，不按这些片段单独 npm test。ACP 自身的映射测试可独立运行。

额度桥符号在 plugin/src/quota.ts 的导出中；Web／扩展消费者应调用该接口，而不是另外搭代理或循环查询 Google 端点。


## 0.1.10／0.1.11 接手增量

`/agy-acp doctor` 查看本地绑定、运行状态、设置与目录诊断，不发模型请求；`/agy-acp reset` 停止当前原生执行并清除绑定，保留 Pi 聊天，持久 reset 标记防止重开后恢复旧检查点。下一次输入开启新的原生会话，不自动回灌 reset 前全部历史。

模型目录先用 Pi agent 目录内上次成功缓存或内置目录；选中 ACP 后按有效期刷新，`/agy-acp models` 手动调用 `agy models`，失败保留上次成功目录并报告原始错误。非 ACP 普通会话不会为此启动 AGY。当前原生错误不推进已接受检查点，历史旧错误不污染本轮成功。

0.1.11 在插件统一 message writer 失败出口区分确定的原生终态与传输异常：稳定摘要供 Pi 分类，同条正文和 diagnostics 保留完整原文，`stopReason: error` 不变；摘要独立 runtime 同样经过出口。此策略不新增宿主补丁、原生重试引擎或全局 retry 设置；既有 Pi 1.5.2 overlay 仅是开发兼容基线。错误矩阵与升级限制见 [error-recovery.md](error-recovery.md)。实际完成状态由 [../VERIFICATION.md](../VERIFICATION.md) 记录。
