# AGY × Pi ACP 完整开发交接包 · 0.1.11

这是供继续开发的独立 ACP 插件交接包：完整源码与测试、锁定运行依赖、既有 Pi 1.5.2 开发兼容参考、安装技能、踩坑与安全历史证据。不是原机器备份，也不是完整 Pi Web 应用。源码版本及文件数以 stage 后 `SOURCE.json` 为准，最终封包与实测状态见 [VERIFICATION.md](VERIFICATION.md)。

## 接手前先看

**不要反复打 AGY／Google 接口或会转发真实请求的端口，不另搭正向 TLS 解密抓包代理。遇到 429／403 停止诊断探针及其自动重试。** 先读[在线诊断禁忌](docs/safety.md)。反复请求叠加代理指纹差异是原使用者的重点封号怀疑；没有服务端具体判因证据。

保活没有被验证成功，安装步骤不启用保活或修改 agy.exe。[保活失败复盘](docs/keepalive-failure.md)保留五条请求最终用量、唯一首针和零热基线证据。

## 本版交接重点

- 保留 0.1.10 的 `/agy-acp doctor`、持久 `/agy-acp reset`、成功模型目录缓存与错误检查点保护；不回退源码。
- 0.1.11 采用纯插件终态错误策略：AGY 已有内部重试；确定的原生终态使用稳定失败摘要，同条正文和 diagnostics 保留完整原文，`stopReason: error` 不变，避免 Pi 叠加整轮重试。统一 writer 覆盖普通调用与摘要直调。
- 不新增宿主补丁、不改全局重试设置；其他 provider、上下文超限、取消与通信断开保持既有路径。随包 Pi 1.5.2 overlay 只是既有开发基线，不是本次重试修复。
- 策略依赖当前 Pi 1.5.2 的文案分类，升级后须重跑离线兼容测试；完整职责、错误矩阵和原生重试限制见 [错误恢复说明](docs/error-recovery.md)。

## 最短上手

1. 解压到长期目录。开发需 Python 3.12+、Node.js 24、npm、Git；在线正常使用另需自己的 AGY 安装与认证。
2. 在包根运行 `python -B scripts/verify.py`，核对未修改交付文件。
3. 按[开发接手书](AGENT-HANDOFF.md)在独立副本安装依赖、恢复既有兼容基线并离线测试。
4. 可直接交给 Coding Agent：
   > 读取本包 skills/agy-acp-setup/SKILL.md，先完成离线开发环境与测试；不要发真实服务请求，不修改我的全局配置。
5. 技能可复制到 `~/.pi/agent/skills/`、`~/.claude/skills/` 或 `~/.agents/skills/`；同时保留本包并向 agent 提供包根路径。

## 包内地图

| 路径 | 用途 |
| --- | --- |
| `plugin/` | stage 后的 ACP 完整源码、测试、Schema、锁文件及生产依赖 |
| `AGENT-HANDOFF.md` | 安装、开发、验证与恢复入口 |
| `docs/architecture.md` | 文件职责与数据／工具流，含 0.1.10 接手能力 |
| `docs/error-recovery.md` | 0.1.11 纯插件策略、原生重试边界、错误矩阵与升级检查 |
| `docs/pitfalls.md` | 已修问题、历史失误与保留边界 |
| `docs/safety.md`、`docs/keepalive-failure.md` | 在线安全提醒与保活失败分析 |
| `host-reference/` | stage 后的既有 Pi 1.5.2 overlay、可读差异与独立分支 Web 参考 |
| `references/binary-patches/` | 窗口／保活历史配方，仅参考，不自动应用 |
| `evidence/` | stage 后的冻结安全证据，只作离线读取与复算 |
| `licenses/` | 第三方许可；依赖包也保留原许可证 |
| `SOURCE.json`、`manifest.json` | stage 来源指纹与 seal 后逐文件大小／SHA256 |

本包不含账号凭据、完整私人提示词、真实会话数据库、agy.exe、观察器启动脚本或旧 native 桥。原工程绝对路径只作历史来源，不是开发前提。许可见 [THIRD_PARTY.md](THIRD_PARTY.md)。
