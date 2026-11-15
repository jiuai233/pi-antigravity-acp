# 许可与第三方来源

- plugin/package.json 声明 MIT。桥、名称、输出等冻结复用自 antigravity-native，本包保留原MIT许可 licenses/antigravity-native-MIT.txt；提取边界见plugin/frozen-sources.json。
- @agentclientprotocol/sdk 2.6.0：Apache-2.0，原包LICENSE随生产依赖保存。
- @bufbuild/protobuf 2.16.0：Apache-2.0 AND BSD-3-Clause。npm包未带独立LICENSE文件，Apache正文从其官方v2.16.0仓库取得；BSD正文来自本包原始wire/varint.js头部，均在licenses/。
- Zod 3.25.76：MIT，原LICENSE随依赖保存。
- Pi 1.5.2宿主overlay及Web参考含上游与本地修改；对应Pi许可从官方npm包保存于licenses/，overlay以SOURCE.json和host-reference/overlay.json标注，源码差异在host-reference/patches。Web上游声明见host-reference/piweb-LICENSE。
- resources/history-schema.json中的持久化AES格式常量不是账号OAuth凭据。包内不含用户令牌、认证数据库、私有推理或商业exe。
- 第三方服务的可用性、认证和账号状态按接手者自己的当前条件判断。本次不查询产品政策更新，也不把使用官方SDK解释为账号使用方式获得额外许可。

既有 Pi 1.5.2 overlay 保留为独立开发兼容参考；ACP 0.1.11 的终态错误／避免叠加重试策略只修改插件，不新增宿主补丁，也不要求为重试修复覆盖全局 Pi。实际来源与依赖版本以新包 stage 生成的 SOURCE.json、plugin/package.json 为准。
