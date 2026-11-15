# 踩坑与接手检查表

先读 [在线诊断禁忌](safety.md)。下面记录历史问题与当前源码处理；历史用例通过的范围不等于接手机器已在线验证。

| 踩坑 | 已采用的处理／检查点 |
| --- | --- |
| 把 429 一律当额度不足 | 身份提示有独立对照：中性两轮成功、Pi harness 两轮 429；原生身份带73工具仍成功。只支撑该样本，不解释403封停或全部429 |
| 关闭 customization 发现以“隔离” | 会回退默认 agent；开启发现，私有 agent 设置 excludeDefaultComponents/inheritCustomizations；核原生编译产物 |
| 导入只保留历史，漏持久 agent metadata | 零生成编译取得 staticConfig/agentScript，再与结构化历史一起发布新 UUID；不手写默认提示模板 |
| 工具60秒断开 | HTTP头先发，JSON-RPC结果仍等真实Pi工具；不能预填成功 |
| 工具180秒断开 | 私有 Gemini mcp_config.json 的 timeoutSeconds:-1；new/load 传空 mcpServers，避免把超时覆写回180秒。旧150秒主动切等待策略不是当前默认方案 |
| 私有MCP配置加未知字段 | proto3解析可能整表失败；不直接塞 tools.eager 等未支持字段 |
| 大目录变成call_mcp_tool，误判工具丢失 | 完整签名、说明和Codemode返回契约保留；复杂Schema外置；只对当前桥精确别名转发 |
| 动态激活工具就重开生成 | 在挂起MCP时刷新桥与Schema、交付真实结果；下一空闲回合更新agent快照 |
| 权限只准read_file，误伤Pi工具 | 权限回调也包MCP；按本桥精确别名识别，执行交Pi，不宽放任意mcp_前缀 |
| 正文10KiB卡边，又被包装头二次截断 | 桥上限9,984字节，预留256字节；完整输出归档。控制字节被原生判二进制时用Pi read读完整归档 |
| 工具别名依赖发现顺序 | 使用无状态确定性别名；历史导入统一编码call_mcp_tool，服务名acp-tools |
| 旧pi-acp检查点直接复用 | 0.1.9检测旧桥名，执行一次结构化冷导入，保留Pi有效历史 |
| stale options把xhigh降成high | 模型设置后消费原生新configOptions；原请求值与实际回报分开，不以旧本地广告表静默降档 |
| 为切模型／档位重建全部历史 | 执行配置与历史判据分开；原地设置，忙碌失败记录延后，不取消真实工具结果 |
| 缺stepIndex仍盲load原生尾部 | 没有准确检查点不继续未接受尾部；按Pi有效历史冷导入，有边界则Fork/Revert新分支 |
| 复制SQLite主文件漏WAL | Node在线backup；protobuf原样复制；不修改源数据库，不靠复制索引臆测修复 |
| session/close已返回，Windows仍锁文件 | 完整进程退出后清理独占seed；短暂句柄释放延迟用现有删除重试 |
| worker更换，旧端口缓存还在 | 从私有日志重新定位，按mtime选worker，不按PID字符串排序或扫描全部端口 |
| 迟到通知串入下一轮 | 用原生session、prompt阶段与进程source归属校验；旧正文仅诊断，usage不改当前水位 |
| 原生read_file看不见，就造Pi toolCall | 用pi-native-tool展示记录，按ID合并；不进模型、不重执、不添加额外模型回合 |
| 把视频读取通过说成精确时标通过 | 历史MP4整字节原样送达、画面识别通过；真实切换2.4秒，回答约2秒，精确时标未通过；不扩大为上传框/跨投影视频支持 |
| 计量错误当0或把多代累计当水位 | inference差分计费，水位取最后一代；缺数据标unknown，不把已生成正文作废 |
| 后台保活请求发出就宣称续期成功 | 本轮两次热基线均0、首针完整仍0、无第二针、600秒后0。详见保活失败复盘 |

## 证据入口（归档于 `archive/handoff-kit-0.1.11`）

- 身份／429：`evidence/prompt-identity/` 两轮 summary 与 73 工具公开结果。
- 保活：`evidence/keepalive/` 完整安全 JSONL、最终分析、单字节 manifest 及汇编摘录。
- 其他历史接缝：由 `plugin/` 源码与对应测试定义当前行为。


## 错误恢复新增检查点

- 不在 `message_end` 单点改错误：压缩摘要可直接调用 provider；统一 writer 出口要覆盖普通调用和摘要调用。
- 不把错误改成成功，也不丢原文：确定的原生终态使用稳定失败摘要，正文及 diagnostics 保留完整原文，停止原因为 error；上下文超限、用户取消及 ACP 通信断开保留原路径。
- 不叠加整轮重试：AGY 已有内部重试；Pi 不应因原文 503／429 再从头发本轮。已完成工具不能因错误重新执行，用户明确新输入仍是新一轮。
- 不将旧 attempt 1..5 日志当作固定五次预算；次数依原生配置，完整公开控制参数未知。
- 不把 0.1.10 的 doctor、持久 reset、成功模型目录缓存、错误检查点保护回退。`reset` 是用户显式丢弃绑定，不是自动错误恢复按钮。
- 不把原 Pi 1.5.2 overlay 叫作重试修复：0.1.11 策略仅改插件，依赖 Pi 1.5.2 当前文案分类；升级后重跑 [error-recovery.md](error-recovery.md) 的离线兼容检查。
