# pi-antigravity-acp

Pi 的 Antigravity 原生 ACP（Agent Client Protocol）Provider 扩展，通过 `agy acp` 与本地 loopback MCP 工具桥接执行 Pi 工具链，并提供额度面板与前缀缓存审计。

## 安装

```bash
pi install git:github.com/jiuai233/pi-antigravity-acp
```

运行前提：

- Node.js 24+
- 已安装并完成认证的本地 `agy` CLI

## 内置命令

- `/agy-usage`：查看当前账号的 Antigravity 5 小时与周额度（优先复用活跃 ACP 连接，无活跃会话时按需冷查询；60 秒内打开复用缓存，弹窗内点 `Refresh` 强制实时刷新）。
- `/agy-acp [status|cache|reset|doctor|models]`：
  - `status`（默认）：查看当前会话绑定的原生 `conversationId`、模型、步数及上次缓存命中率。
  - `cache`：查看本地与原生前缀/用量采样审计详情。
  - `reset`：中止当前执行并清除 ACP 原生会话绑定与状态栏缓存记录（保留 Pi 聊天记录，下轮新建原生会话）。
  - `doctor`：输出本地二进制路径、运行时、模型目录和缓存审计诊断（不发模型请求）。
  - `models`：手动运行 `agy models` 刷新模型目录并更新缓存。

## 目录结构

- `plugin/`：ACP 运行时、MCP 工具桥、结构化历史同步、额度桥与离线单测。
- `docs/`：架构说明、错误恢复边界、踩坑表与安全约束。

完整历史交接物（`host-reference/`、`evidence/`、`SOURCE.json`、`manifest.json` 等）已归档在 Git tag `archive/handoff-kit-0.1.11`。

## 开发与测试

```bash
npm test
npm run typecheck
```

- `npm test` 会自动回退复用本机全局 `@earendil-works/pi-*` 宿主包，即使在 `pi install` 安装的目录中也可直接执行全部离线测试。
- `npm run typecheck` 需要本地或全局可用的 `tsc`（或通过 `PI_ACP_TSC_BIN` 指定）。
- 许可信息见 [THIRD_PARTY.md](THIRD_PARTY.md) 与 [plugin/THIRD_PARTY.md](plugin/THIRD_PARTY.md)。
