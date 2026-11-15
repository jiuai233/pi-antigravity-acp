# Antigravity ACP provider

独立的 Pi provider：Pi 管会话历史、工具循环、会话树和压缩；AGY 通过官方 ACP SDK 执行有效上下文。provider 名为 `antigravity-acp`，不替换现有 `antigravity` 插件。

## 开发入口

需要 Node.js 24、Pi 1.5.2，以及已登录的 AGY。结构化历史使用 `resources/history-schema.json` 中的原生 protobuf 字段与公共持久化 AES 格式常量，不读取 exe 固定偏移，也不按版本或文件哈希准入。原生加载、配置与协议错误直接报告，不假装导入成功。

在插件目录安装依赖，然后显式加载源码扩展：

```bash
cd E:/pi-stack/plugins/antigravity-acp
npm ci --ignore-scripts
pi -e E:/pi-stack/plugins/antigravity-acp/index.ts
```

在模型选择器中选择 **Antigravity ACP** 分组；新组所有模型显示名均带 **(ACP)** 后缀，模型ID仍保持原生值，与旧组通过provider身份隔离。`AGY_BINARY` 可以指定 exe；未设置时从 PATH 查找。

| 命令 | 作用 |
| --- | --- |
| `/agy-acp` | 显示当前原生会话 ID、模型与检查点。 |
| `/agy-acp models` | 通过 `agy models` 手动刷新模型目录，不发生成请求。成功目录保存到当前 Pi agent 目录的 ACP 缓存；失败保留上次成功目录并报告错误。 |
| `/agy-acp doctor` | 查看本地原生绑定、运行状态、设置和模型目录诊断，不发模型请求。 |
| `/agy-acp reset` | 停止当前原生执行、清除原生绑定；保留 Pi 聊天记录，下一次用户输入从新的原生会话开始，不自动回灌 reset 前的全部 Pi 历史。 |

选中 ACP 时会按目录有效期自动刷新模型；启动先使用已保存的成功目录或内置目录。普通非 ACP 会话不会为目录刷新启动 AGY。reset 会保存独立的会话标记，重开 Pi 后也不会恢复 reset 前的原生检查点；后续正常生成、分叉或压缩继续按 Pi 的有效历史规则处理。

上述显式加载不修改全局 packages。持久并排试用使用独立单元 `plugin.antigravity-acp` 的 prepare/activate，再向 `enabledModels` 追加 `antigravity-acp/…` 范围并热重载；旧 `antigravity` 包、模型范围、默认选择和运行状态不替换。试用安装及真实网页入口结果见 `notes/verify/agy-acp-parallel-trial-20261113.md`。

## 会话与继续

- Pi 会话树是权威记录。正常工具循环通过 MCP 等待真实 Pi 结果，在新的 Pi 请求取得 owner 后继续同一个 ACP prompt；不会重复提问或重执已完成工具。
- 当前原生 prompt 的结构化终态错误仍以 `stopReason: error` 交给 Pi，不将警告当作成功，也不以错误步骤推进已接受检查点。AGY 原生负责自己的重试；原生恢复策略结束后，插件用稳定失败摘要阻止 Pi 再启动整轮，完整原文保存在同条正文和 `agy_acp_native_recovery_finished` 诊断中。上下文超限仍交 Pi 压缩，用户取消仍为 aborted；没有原生终态证据的启动／通信故障仍保留原始错误和宿主恢复路径。该兼容方式依赖 Pi 1.5.2 的错误文案分类，升级后运行 `test/retry.test.mjs`，不需要修改宿主或关闭其他 provider 的重试。历史错误或当轮已恢复的错误不误判成功回复。
- 历史、模型／档位和进程装载分别处理。模型／档位直接交给原生设置接口，不要求本地广告表匹配，不因更换选择而换会话 ID。
- 切模型后记录原生返回的实际设置值，再提交所请求档位；没有回报值时记为未知，不用字符串全等拦截请求，也不把请求的 xhigh 冒充已生效。`off/minimal` 对应 `low`，`max` 对应 `xhigh`；未指定 reasoning 保持原生现值。
- 重开／树导航从检查点对应的 Pi entry 投影恢复已接受前缀及系统／工具基线，再与当前有效请求比较；一致且游标覆盖已接受内容时原生 Fork/Revert。缺游标、遥测未覆盖已接受回复或旧记录缺前缀时，导入当前有效历史，不盲 load 未接受尾部、不拒发。真实分叉／装载失败仍报错。
- 历史编辑、压缩、外部 provider 新增历史或系统／工具定义改变，且没有可匹配检查点时，导入当前有效的 user/assistant/toolCall/toolResult 历史，以新 UUID 发布，不修改旧库。系统／工具变化会重开 worker，重新编译 agent metadata 并重新接入 MCP，不能只刷新本地目录冒充原生已更新。实际代理环境变化只重开进程，历史仍按原生 ID／步骤恢复，不额外计算 CA 文件哈希。
- 新检查点保存原生会话／步骤和 Pi entry，不保存 configHash、projectionHash、piHistoryHash 或 stepsHash；旧检查点也不需要补哈希证明。树导航直接选择目标 Pi 分支上的检查点。
- 末尾只有工具结果时，ACP 的非空输入要求由一条传输层 host continuation 满足。它不重复业务问题，不写入 Pi 用户历史，也不代表原生 `continue_after_injection` gate 已开放。
- Pi 树导航优先使用原生 Fork/Revert；跨目录 SQLite 通过 Node 在线 backup 包含已提交 WAL，protobuf 按字节复制。回退只作用于新分支。
- Pi 压缩请求使用独立 runtime；主原生会话不会被摘要请求改写。压后只导入 Pi 提供的新投影。

## 工具和等待

Pi 工具仍由宿主 runner 执行并接受其权限/工具钩子；私有 agent（`acp-agent`）恢复 AGY 原生 `<identity>`，剥离宿主默认 harness 前言（`running inside pi...`）、顶部重复 `<tools>`、`<docs>` 与 `PI_*` 环境说明，完整保留 `<rules>`、附加 `<addendum>`（如 `<行为准则>`）、项目上下文（如本机环境与 `AGENTS.md`）、`<skills>` 与 `<cwd>`。默认原生 profile 只声明 `read_file`；`call_mcp_tool` 是 AGY 随 MCP 注入的动态传输工具，不写入 builtin 工具组件名单。完整工具集经私有 MCP 服务 `acp-tools` 接入时，AGY 将本桥收拢在 `call_mcp_tool` 后按需转发；私有 agent 通过中文 `<acp_tool_bridge>` 与 `<acp_active_tools>` 内联参数签名及完整工具说明（含 `codemode` 沙盒全局接口、嵌套工具与各工具 `Codemode:` 返回值契约），深层参数 JSON Schema 放在 `<stateDirectory>/schemas/acp-tools/`；输出裁切预留 AGY 时间戳包装头余量以避免二次截断。工具别名由名称确定，不随发现顺序变化；结构化冷导入将历史工具调用统一编码为 `call_mcp_tool`（携带 `ServerName: "acp-tools"`、确定性别名与原始 `Arguments`），旧版 `pi-acp` 检查点在恢复时自动执行一次结构化冷导入切换至 `acp-tools`。回合中动态激活工具（如 `codemode` 内调用 `setActiveTools`）实时刷新桥目录与外部 Schema 并直接交付结果，不中断当轮原生生成，待下一空闲回合同步私有 agent 快照。闭卷 `evidence_only_v1` profile 不开放读取，只桥接当前卷宗的提交工具并在 `<acp_tool_schemas>` 内联 Schema。权限按当前原生会话与调用更新处理，name 可省略并复用已有调用信息；已发布的本桥 MCP 别名可获准转发至宿主 runner；其他非 profile 工具不自动授权。真实工具 ID、名称、参数与结果配对后释放等待。挂起 MCP 时尝试原生设置；设置失败记录原始错误和实际回报，但仍交还真实工具结果，不依赖英文 busy 正则，不为此取消生成。

原生 `read_file` 活动保存在独立 `pi-native-tool` 展示记录中，以原生调用 ID 合并状态；不添加模型消息、不把它当作 Pi 工具重执。

桥先发送 HTTP 响应头，JSON-RPC 工具结果仍等待实际完成。插件没有长工具总时限；私有 Gemini 配置中的 MCP `timeoutSeconds: -1` 同时关闭 AGY 默认的 180 秒调用时限。ACP 的 `session/new` / `load` 不重复传入同名 MCP 描述，避免覆盖超时设置。用户取消、工具本身的执行时限、原生真实退出或终态仍正常收尾；断开后的续接以 Pi 保存的真实结果为准。

显式 agent 启动时开启其发现（`include-default-customizations=true`）；隔离由私有 agent 的 `excludeDefaultComponents: true` 与 `inheritCustomizations: false` 提供。把发现全关会导致原生回退默认 agent，不能当作隔离手段。

## 内容与计量

- 系统提示保存在原生专属 agent 配置中，不伪装为用户历史。
- 图片/音频按实际内容转换为原生 media，兼容 URL-safe、空白和省略 padding 的 base64；其他资源在无法直接表示时保留为可见的完整内容，不以模型名推测视觉准入。
- 公开思维只接 ACP `agent_thought_chunk`，不从私有记录提取隐藏思维。历史思维/签名按 Pi 的公开转换 helper 处理。未接受助手及其配对结果不进入冷导入，真正无主／错误 ID 的结果仍报错。
- 外会话、旧进程或已结束 prompt 的正文仅保留来源诊断，不拼入后续助手正文；相应 usage_update 不改当前上下文水位。模型设置的请求值与本次原生回报分开记录，关闭进程即清除旧设置缓存。
- 每次新推理按原生 inference 差分计量；上下文水位采用最后一代。缺失/坏计量标记 unknown（JSON 数值为 null），不伪造免费用量，也不作废已生成回复；美元金额只是目录估算。

## 数据位置

默认在 Pi agent 目录的 `antigravity-acp/` 下以现有会话 ID 的路径编码保存私有状态；`AGY_ACP_STATE_DIR` 可指定隔离目录，既有检查点的 nativeHome 仍用于恢复。可选网络观察配置失败只报告诊断并沿用上次有效或继承的传输环境，不静默清除代理；URL、证书和连接错误由原生网络接口报告。

## 验证和维护

```bash
cd E:/pi-stack/plugins/antigravity-acp
npm run typecheck
npm test
```

复用边界的轻量回归可单独运行：

```bash
node --experimental-strip-types --test test/runtime.test.mjs test/history.test.mjs test/models.test.mjs test/native.test.mjs test/native-tools.test.mjs
```

这些用例验证控制流、配置确认、历史导入与 UI-only 记录，不代表真实 AGY 忙碌配置时序或重载后的目录已经验收。历史加密往返测试无需 exe 或版本标记；离线测试不启动 AGY 或请求模型。真实 SDK/AGY 场景由本仓 `notes/verify/agy-acp-plugin-final-20261113.md` 索引，功能结果以该报告为准。

复用边界与第三方来源见 [THIRD_PARTY.md](THIRD_PARTY.md) 和 `frozen-sources.json`。
