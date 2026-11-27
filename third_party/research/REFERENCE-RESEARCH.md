# 三个参考项目与真实用户需求调研

## 2026-11-28 更新

以 11 月 26 日记录为基线，按北京时间核对正式发布、默认分支提交和近期用户反馈。三个仓库中只有 cc-switch 开启了 GitHub Discussions，另两个项目的反馈取自 Issues 与评论。

### cc-switch

- v4.0.43 修复 OpenCode 2.4 历史只显示提问的问题。v4.0.44 新增 ZCode 桌面接入，并按 New API 返回的主接口类型过滤非对话模型。云桥先前会把纯生成图片、视频、向量和重排模型一起导入对话列表，本轮修复了这个问题，保留已有选择和可读图的对话模型。[v4.0.43](https://github.com/farion1231/cc-switch/releases/tag/v4.0.43) · [v4.0.44](https://github.com/farion1231/cc-switch/releases/tag/v4.0.44) · [模型筛选反馈和发布确认](https://github.com/farion1231/cc-switch/issues/10026#issuecomment-7222905824)
- 云桥新增 ZCode 桌面入口并保留原 CLI 入口。在 Windows 本机识别到 ZCode 4.0.0。接入指南按 ZCode 的原生界面填写 API 格式、基础地址、密钥和完整模型 ID，由用户在 ZCode 选用。上游另有个人供应商文件写入、MCP 和会话管理功能。[cc-switch ZCode 接入](https://github.com/farion1231/cc-switch/pull/9824) · [ZCode 4.0 官方界面文案](https://github.com/zai-org/ZCode/blob/v4.0.0/packages/ui/src/i18n/locales/zh-CN.ts#L4295-L4315) · [ZCode 4.0 实际请求路径测试](https://github.com/zai-org/ZCode/blob/v4.0.0/apps/zcode-cli/packages/adapters/tests/connectivity-probe-wire.test.ts#L84-L92)
- Discussion #9692 的回复描述了旧会话里的 MCP 历史被新供应商拒绝。Issue #10057 希望重启后仍能看到上次的额度与套餐快照，核对时仍开放。另用临时 SQLite 样本确认，云桥历史页尚未接入 OpenCode 的数据库会话源，2.4 的分段消息读取仍待适配。[MCP 续聊讨论](https://github.com/farion1231/cc-switch/discussions/9692#discussioncomment-19930014) · [额度快照需求](https://github.com/farion1231/cc-switch/issues/10057) · [OpenCode 2.4 修复确认](https://github.com/farion1231/cc-switch/issues/9982#issuecomment-7196521648)

### CodexPlusPlus

- 最新正式版仍为 v2.8.0。11 月 27–28 日的主分支提交整合供应商列表、加入 Gemini 上游、拆开 Claude Code 与 Claude Desktop，并改进 Chat 被过滤或截断时的结束状态。Antigravity 接入与用量快照是仍在讨论的需求。[v2.8.0](https://github.com/BigPizzaV3/CodexPlusPlus/releases/tag/v2.8.0) · [供应商与客户端更新](https://github.com/BigPizzaV3/CodexPlusPlus/commit/cb798384adbe15646b8f75003b131dcf124bd536) · [Chat 结束状态修复](https://github.com/BigPizzaV3/CodexPlusPlus/commit/3bb428b5b5e8f5eabe8338435322ceba99b322fa) · [Antigravity 需求](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3312) · [用量快照需求](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3306)
- #3289 报告工具历史被上游拒绝。云桥独立复现了一个成因明确的故障：从 Responses 或 Anthropic 转成 Chat Completions 时，工具调用的 ID 被改写，结果仍引用旧 ID。本轮在同一请求内配对两者，严格校验的模拟上游可接受并行工具逆序返回。该反馈未给出足够信息确认其自身故障的根因。[用户反馈及追问](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3289#issuecomment-7179427306) · [上游历史处理提交](https://github.com/BigPizzaV3/CodexPlusPlus/commit/77c84298a0b65b314760e21cc184fc36c821754a)

### magpie

- 核对时正式版为 v0.1.4984。近期版本增加了通过 CLI 开关局域网共享，修复 WorkBuddy 推理签名回传，也修复了进程运行中新增账号后目录缺少该账号模型的问题。[v0.1.4984](https://github.com/yetone/magpie/releases/tag/v0.1.4984) · [局域网 CLI](https://github.com/yetone/magpie/releases/tag/v0.1.4983) · [WorkBuddy 修复](https://github.com/yetone/magpie/releases/tag/v0.1.4982) · [账号模型目录的修复确认](https://github.com/yetone/magpie/issues/7945#issuecomment-7219462676)
- 开放的 #8030 指出 Gemini 模型目录触及分页上限仍可能显示同步成功。云桥此前只取第一页。本轮支持 Gemini 的 `nextPageToken` 和 Anthropic 的 `has_more` / `last_id`；完整读取后才合并模型，续页错误、游标异常或超出上限会保留原目录。测试使用本机 HTTP 模拟供应商，包含空页续读、第二页失败和第 100 页恰好结束的情况。[Gemini 分页反馈](https://github.com/yetone/magpie/issues/8030)

## 2026-11-26 更新

本轮对照 11 月 15 日的调研和云桥 0.6.12 工作树，核对了三个项目的 Releases、提交、Issues 与可访问的社区讨论。日期按北京时间。cc-switch 开启了 GitHub Discussions，CodexPlusPlus 和 magpie 在核对时均未开启，该两项的用户反馈取自 Issues。

| 项目 | 上游变化与社区反馈 | 本次云桥改动 |
| --- | --- | --- |
| cc-switch | v4.0.41 加入 CodeBuddy 支持；v4.0.42 增加 GitHub Copilot Auto，并修正 Antigravity 标签串到其他客户端的问题。Discussion #9813 中有用户反馈，新版 Codex Desktop 的新会话只显示官方模型，旧会话仍可显示原模型。该讨论尚不足以证明云桥存在同一故障。[CodeBuddy PR](https://github.com/farion1231/cc-switch/pull/8758) · [v4.0.42](https://github.com/farion1231/cc-switch/releases/tag/v4.0.42) · [Discussion #9813](https://github.com/farion1231/cc-switch/discussions/9813) | 支持读取 CodeBuddy CLI 的项目会话目录，保留旧目录，通过现有历史页查看和导出消息。续聊需核对会话标识与原项目路径。 |
| CodexPlusPlus | v2.8.0 增加独立压缩模型、图像输入模型、微信会话管理，并修复空闲后 WebSocket 续接失败。多账号和多 Key 的进一步改动已进主分支。#3115 报告的技能开关丢失已关闭，#2983 的跨客户端 MCP 与 Skills 管理需求仍开放。[v2.8.0](https://github.com/BigPizzaV3/CodexPlusPlus/releases/tag/v2.8.0) · [多 Key 提交](https://github.com/BigPizzaV3/CodexPlusPlus/commit/492e869e520ef27ea19cd85681a7d1f3486ecdae) · [#3115](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3115) · [#2983](https://github.com/BigPizzaV3/CodexPlusPlus/issues/2983) | 修复可复现的 Codex 资源列表和切换问题：识别带点号或引号的 MCP 名称，忽略多行文本中的伪表头，将嵌套配置归属于原服务器。可精确写入的开关保留注释、换行及无关字段。 |
| magpie | v0.1.4799 修复部分 Responses 文本缺少引用数组导致的 SDK 兼容问题；v0.1.4804 修复链接里的隐私占位符还原；v0.1.4809 让共享中的网关保持主机唤醒。#7723 另报告了流式遮蔽文本还原异常，#7748 请求按实际账户的可用模型路由。[v0.1.4799](https://github.com/yetone/magpie/releases/tag/v0.1.4799) · [v0.1.4804](https://github.com/yetone/magpie/releases/tag/v0.1.4804) · [v0.1.4809](https://github.com/yetone/magpie/releases/tag/v0.1.4809) · [#7723](https://github.com/yetone/magpie/issues/7723) · [#7748](https://github.com/yetone/magpie/issues/7748) | 修复云桥非流式原生 Responses 文本缺少 `annotations` 的情况；按请求还原 URL 中被编码的遮蔽占位符，覆盖跨流式分片；增加桌面端局域网共享防休眠开关，默认关闭。 |

仍值得单独验证的需求包括 OpenCode 2.4 历史格式、Windows 与 WSL 分开的资源和配置目录、路由组中每个账号实际可用的模型。本轮没有这些场景的原生兼容性结论。云桥原有的多 Key、路由策略和备份能力没有重复移植，内置 CodexPlusPlus 扩展仍使用原固定版本。[OpenCode 反馈](https://github.com/farion1231/cc-switch/issues/9982) · [WSL 反馈](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3235) · [账户模型反馈](https://github.com/yetone/magpie/issues/7748)

另有两条 cc-switch 讨论与云桥的旧会话直接相关。#9692 描述了 Claude Desktop 更换供应商后，旧消息里的 MCP 内容被新上游拒绝；#9560 希望额度不足时自动换源并保留会话。后续验收应分别检查本地消息仍可阅读，以及目标供应商能否实际接受同一段工具调用历史。[跨供应商会话讨论](https://github.com/farion1231/cc-switch/discussions/9692) · [额度切换需求](https://github.com/farion1231/cc-switch/discussions/9560)

## 2026-11-15 调研记录

调研日期：2026-11-15（Asia/Shanghai）。通过 GitHub 公开 API 阅读三个项目当前 README、按评论数排序的 Issues 样本、重点 issue 正文和部分评论，以及 cc-switch Discussions 前 50 条公开主题。该样本适合发现需求，不是全站统计，不能推导「某类问题占一半」之类比例。已关闭的 issue 说明历史需求，不能据此断言当前版本仍有同样缺陷。

CodexPlusPlus 的仓库元数据 `has_discussions=false`；其 Discussions API 返回 410。magpie 的 Discussions API 也返回 410。因此这两者以 Issues 和 issue 评论作为用户讨论来源，没有虚构独立讨论区内容。

## 项目长处

| 项目与来源 | 当前公开能力 | Aurora 值得吸收的设计 |
| --- | --- | --- |
| [CodexPlusPlus README](https://github.com/BigPizzaV3/CodexPlusPlus#readme) | 统一 Agent 管理；本地网关；供应商池与模型组；会话；Codex 增强；Claude Desktop 增强；MCP、Skills、扩展；多开与工具协作 | 让客户端、扩展和会话处于同一工作台；高级能力按需启用；插件安装显示能力并默认关闭未经审核的代码 |
| [cc-switch README](https://github.com/farion1231/cc-switch#readme) | 按工具配置供应商；预设；连接字段最小修改和备份；四协议路由/聚合；MCP、Skills、Prompts；会话；用量；云同步与 WSL | 先选客户端后选供应商；改动预览；保留用户原配置；模型与供应商易搜索；清楚区分直连、路由、聚合 |
| [magpie README](https://github.com/yetone/magpie#readme) | 本地网关；四协议；供应商/订阅；多账号路由；会话黏性；隐私遮蔽；插件中间件；WebUI/Docker/CLI；远程管理 | 连接、模型、路由共享数据；请求失败的可解释性；移动端/无界面管理；供应商目录动态刷新 |

三个项目都已具备较丰富功能，不能再把 cc-switch 简单描述为「只有切配置」，也不能笼统认定 magpie「只支持 macOS」。CodexPlusPlus README 明确说明不修改官方应用安装文件，但其部分增强仍依赖官方页面结构/CDP，需要版本适配。0.6 已引入 CodexPlusPlus 的固定版本源码与扩展资源并保留 AGPL 及组件许可，详见[集成记录](../INTEGRATION.md)；cc-switch（MIT）与 magpie 在本项目中作为功能和流程研究来源。

## 用户真正关心的事

| 用户讨论证据 | 需求判断 | 对 Aurora 的设计要求 | 优先级 |
| --- | --- | --- | --- |
| [cc-switch #1855](https://github.com/farion1231/cc-switch/issues/1855) 的新 CLI 工具跟踪表及评论，含 Qwen、WorkBuddy/CodeBuddy、Kimi、Cursor 等 | 用户想按自己手头客户端接入，而不是先理解供应商协议 | 客户端入口、能力矩阵、明确自动配置/手动配置/受限状态；稳定适配器接口 | P0 |
| [cc-switch Discussion #1883](https://github.com/farion1231/cc-switch/discussions/1883)「openrouter 怎么配置给 claude code」、[#1698](https://github.com/farion1231/cc-switch/discussions/1698) 硅基流动模型配置问题 | 预设存在并不等于用户能完成配置 | 就地新增供应商、自动解释协议、模型拉取、最终可用性测试 | P0 |
| [Codex++ #327](https://github.com/BigPizzaV3/CodexPlusPlus/issues/327) 工具调用必须有对应 tool 消息；[cc-switch #2282](https://github.com/farion1231/cc-switch/issues/2282) thinking 回传错误 | 跨协议可用性比供应商数量更关键 | 工具往返和推理字段回归；保存原错误；明确已验证组合 | P0 |
| [cc-switch Discussion #1938](https://github.com/farion1231/cc-switch/discussions/1938) Codex Responses 404；[#1973](https://github.com/farion1231/cc-switch/discussions/1973) DashScope content 字段错误 | 填对地址后仍可能选错协议或模型能力 | 预览最终 endpoint、协议与路径；不能仅用 `/models` 成功宣称对话一定可用 | P0 |
| [Codex++ #352](https://github.com/BigPizzaV3/CodexPlusPlus/issues/352) 更新后历史不可见；[cc-switch #7257](https://github.com/farion1231/cc-switch/issues/7257) 区分 provider 分桶和跨供应商加密上下文 | 用户最怕切换/升级后任务断掉 | 保留备份、只读聚合历史；区别「看得到」和「能继续」；不自动重写会话文件 | P0 |
| [magpie #994](https://github.com/yetone/magpie/issues/994) 固定 provider ID；[#2642](https://github.com/yetone/magpie/issues/2642) 原生压缩只能原账号读 | 账号/供应商切换与上下文存在绑定 | 稳定配置标识；遇到不能跨账号续接的上下文明确提示，而非删除信息或承诺无损迁移 | P0 |
| [Codex++ #3001](https://github.com/BigPizzaV3/CodexPlusPlus/issues/3001) 新会话找不到模型；[#1594](https://github.com/BigPizzaV3/CodexPlusPlus/issues/1594) 上下文被固定值覆盖 | 用户需要模型和参数真实生效 | 远端目录版本、刷新模型、原始 ID、配置与实际调用一致；上下文非硬编码 | P0 |
| [magpie #1418](https://github.com/yetone/magpie/issues/1418) 用户希望满载时换上游；[维护者评论](https://github.com/yetone/magpie/issues/1418#issuecomment-6082716324) 要求查看候选及跳过原因 | 自动重试需要解释，并区分是否已经交付流式输出 | 展示重试/候选结果、耗时与冷却；输出后不偷偷重放 | P0/P1 |
| [cc-switch Discussions #898](https://github.com/farion1231/cc-switch/discussions/898)、[#1665](https://github.com/farion1231/cc-switch/discussions/1665) 请求无 GUI 服务器支持 | 桌面界面不能成为管理 API 的唯一入口 | 保留独立网关 CLI、受控 RPC、远程伴侣 | P0 |
| [Codex++ #101](https://github.com/BigPizzaV3/CodexPlusPlus/issues/101) 移动连接与更新；评论讨论 API 登录和官方手机连接差异；[magpie #545](https://github.com/yetone/magpie/issues/545) 局域网能力共享 | 用户希望离开电脑后仍能查看和管理 | iOS 内置管理 UI、访问令牌、远程会话查看、明确电脑在线要求 | P0 |
| [cc-switch Discussion #1687](https://github.com/farion1231/cc-switch/discussions/1687) Skills 搜不到；[Codex++ #558](https://github.com/BigPizzaV3/CodexPlusPlus/issues/558) 插件市场空白 | 插件的发现、来源和错误状态都影响体验 | 区分内置插件、MCP、Skills；搜索/空状态/错误状态；清单与权限可查看 | P1 |
| [cc-switch Discussion #1038](https://github.com/farion1231/cc-switch/discussions/1038) GLM quota 脚本；[#2171](https://github.com/farion1231/cc-switch/discussions/2171) 离线额度估计 | 用户关心还剩多少、离线时是否能看 | 真实额度与估算用量分开；显示更新时间；失败保留缓存而非显示假零 | P1 |
| [cc-switch Discussion #1823](https://github.com/farion1231/cc-switch/discussions/1823)、[issue #4043](https://github.com/farion1231/cc-switch/issues/4043) Windows 和 WSL 同时管理 | 一个客户端可能有多个安装位置 | 把运行环境/配置路径作为绑定维度，不假定一机一个固定路径 | P1 |
| [magpie #2278](https://github.com/yetone/magpie/issues/2278) 会话页内存压力报告 | 历史多了界面仍须能响应 | 有界读取、索引缓存、分页、取消旧搜索；性能验收数据量写清楚 | P1 |

## 与本项目最相关的产品结论

第一优先级是让一个普通用户能完成「我用 Claude / Codex → 我有某供应商 Key → 选模型 → 应用」，并知道究竟成功在哪里。第二优先级是配置和历史可信：备份、恢复、真实错误、模型实际能力。第三优先级才是扩展数量和高级自动化。

首页以客户端为中心，供应商是可复用的连接资源，厂商是模型来源维度。把三个名词混成一页会迫使用户先学内部结构。首次流程和高级管理共用数据，但信息密度不同。

本次设计不宣称可以把任意 API 塞进所有官方桌面 App。特别是 [cc-switch Discussion #2397](https://github.com/farion1231/cc-switch/discussions/2397) 提到 Claude Desktop 新的 gateway 能力，说明必须核对最新官方入口，不能照旧知识一概判为不支持。0.6 将 ChatGPT、Beta 与原 Codex 桌面版合并为用户入口，但接入判断仍区分实际版本能力，旧聊天客户端不能沿用编码客户端的配置结论。

详细流程、界面、架构、阶段和验收见 [产品与实现设计](../../docs/DESIGN.md)。
