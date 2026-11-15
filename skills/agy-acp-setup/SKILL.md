---
name: agy-acp-setup
description: 安装、开发或接手 AGY ACP Pi provider；用随包源码与离线测试建立独立开发环境，处理会话恢复、工具桥、纯插件终态错误策略和保活失败。
compatibility: Node.js 24、Python 3.12+、npm；在线使用另需自己的 AGY 安装与认证。
---

# 接手 AGY ACP

## 找到包

技能仍在包内时，包根为本技能目录上两级目录；单独复制后，从用户给的解压位置定位同时含 SOURCE.json、plugin/、AGENT-HANDOFF.md 的包根。使用实际路径，不假定有原作者 E: 或 C: 盘。

## 最小闭环

1. 读取包根 docs/safety.md，用已有错误、冻结证据和假 ACP 定位。用户要求不反复打真实接口／转发端口、不新增正向 TLS 抓包代理；封号原因仅是怀疑，不当成官方判因。
2. 在包根执行 `python -B scripts/verify.py`。按 AGENT-HANDOFF.md 在独立副本安装固定 Pi 1.5.2 与开发依赖，保留安装命令的 `--legacy-peer-deps=false`；执行 `python -B scripts/apply-host.py`，再于 plugin/ 执行 `npm test`、`npm run typecheck`，回包根执行 `node scripts/smoke-sdk.mjs`。只恢复既有开发 overlay，不改全局宿主，不启动 AGY 或读取账号认证。
3. 按修改面读 docs/architecture.md 及对应 src/test；沿 Pi 工具 runner、会话树和压缩开发，不另造执行框架。保留 doctor、本地成功模型目录缓存、持久 reset 和错误检查点保护。
4. 会话／工具故障核 owner、真实结果配对、原生会话／步骤、系统及工具 metadata；确有输入变化或缺准确恢复边界时才冷导入。`/agy-acp doctor` 用于本地诊断；reset 会显式清绑定，下一输入不自动回灌旧历史，不将 reset 当自动重试。
5. 错误／重试问题读 docs/error-recovery.md。AGY 内部已有重试；只在确定原生终态时用插件统一 writer 稳定失败摘要，完整原文保留同条正文和 diagnostics，stopReason 为 error；摘要直调也覆盖。其他 provider、超限、取消、通信故障保留原路径，不只在 message_end 改写。不新增宿主补丁或全局 retry 开关；既有 overlay 不是本次修复。升级 Pi 后重跑离线分类兼容矩阵。
6. 保活问题读 docs/keepalive-failure.md，并在包根运行 `python -B evidence/keepalive/analyze.py`，只复算冻结证据。当前结论为零热基线下未取得收益，不启用配方或重放在线实验。
7. 用户要求正常试用时，按交接书显式加载独立副本，使用其自己的 AGY 与授权；区分安装、源码验证和服务端成功。需要新在线证据而未获准时，说明最小问题及已有证据交用户决定，不自行连续探测。

## 接手结果

报告实际修改、命令、退出码、日志、安装采用状态及缺口；以 VERIFICATION.md 的真实记录而非旧包数字判断新版。AGY 1.5.9 的旧 attempt 1..5 不是固定五次；日／账单额度和已识别超过 30 秒的限流等待有停止分支，公开完整控制参数未知。缺在线结果就记录缺口，不拿保活请求发出或离线通过冒充恢复。
