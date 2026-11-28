# Codex CLI 原生连接验证

2026-11-28 在 Windows x64 上运行 `node scripts/test-coexist-native.mjs`。官方稳定版 `codex-cli 0.172.0` 与本机 VS Code 扩展携带的 `0.171.0-alpha.13.2` 各通过 8 项。稳定版压缩包的 SHA-256 与 GitHub Release 公布值一致。脚本使用 PATH 中的 `codex`，也可通过 `AURORA_NATIVE_CODEX` 指定可执行文件。[官方 0.172.0 发布页](https://github.com/openai/codex/releases/tag/rust-v0.172.0)

## 路由与配置

| 模式 | 原生 CLI 的实际表现 |
| --- | --- |
| API 网关 | 临时配置目录没有 `auth.json`。CLI 按生成的地址、网关令牌和默认模型发送请求。模拟供应商收到 `/v1/responses`、原始模型 ID 和供应商自己的 Key。 |
| API 直连 | 关闭云桥网关后，CLI 仍可读取供应商地址和 Key，向含代理路径前缀的 `/proxy/v1/responses` 发送请求并接收回答。 |
| 本地免密直连 | 保留测试官方登录记录，选择免密本地供应商。CLI 正常接收模型回答，模拟供应商收到的请求没有 `Authorization` 头。 |
| 官方账号共存 | 使用测试登录记录和根级 `openai_base_url`、`model_catalog_json`。第三方模型返回 `RELAY_NATIVE_OK`，`official/gpt-fixture` 经单独的官方模拟传输返回 `OFFICIAL_NATIVE_OK`。测试 OAuth 仅到达官方分支，第三方收到自己的 Key。 |
| 配置优先级 | 将子进程的 `OPENAI_BASE_URL` 指向另一个回环端点，CLI 仍使用配置中的 `openai_base_url`。显式选择 `--profile work` 时，`work.config.toml` 可继承根级端点、模型目录，并可逐字段覆盖同名供应商。 |

在 0.172.0 另行验证了 `[model_providers.openai]` 的预存配置。该内置供应商允许 `model_catalog_url` 指向受支持的 ChatGPT HTTPS 主机，但在同一表加入非空 `name` 会触发原生配置错误。云桥在共存预览中展示删除自定义显示名的改动，保留官方目录地址，断开时可恢复原始配置。[保留供应商 ID 的配置校验](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/config/src/config_toml.rs#L962) · [官方目录地址校验](https://github.com/openai/codex/blob/rust-v0.172.0/codex-rs/model-provider-info/src/lib.rs#L799)

这两个版本均拒绝根配置中的旧式 `profile = "work.v2"` 与 `[profiles."work.v2"]`。现代 CLI 用 `--profile` 加载同一 Codex 配置目录下的 `<名称>.config.toml`。云桥保留针对旧版活动 profile 的配置及恢复测试。兼容旧表的历史二进制本轮未运行。[Codex 配置与 profile 文档](https://developers.openai.com/codex/config-advanced#profiles)

## 隔离范围

测试使用独立的 `HOME`、`USERPROFILE`、`CODEX_HOME`、`APPDATA` 和 `LOCALAPPDATA`，并生成测试密钥、OAuth、模型缓存和工作目录。CLI 使用 `--ephemeral`、`--ignore-rules`、`--strict-config` 及只读沙箱。模型服务仅监听回环地址，其他后台 HTTP 请求由本地代理拒绝。测试核对登录文件与已生成模型目录的字节，最后清理临时目录。

桌面适配器与 CLI 共用 Codex 编程配置。本轮使用真实 CLI 和本地模拟 Responses 服务，未验证桌面界面的在线登录、模型菜单、真实账号权限或供应商额度。此前的 `0.169.0-alpha.11.1` 也已通过当时的 5 项共存检查。
