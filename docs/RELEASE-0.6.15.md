# 云桥 AI 0.6.15

- **Windows 客户端重启。** 修复桌面客户端退出过程中点击「重新启动客户端」可能导致重启失败的问题。
- **Claude Desktop 模型选择。** 接入向导按桌面端支持的模型名称筛选供应商目录。保存配置后，所选模型排在首位，其他兼容的 Claude 模型也可在桌面端切换。
- **同步模型列表。** 同步 Gemini 和 Anthropic 供应商时会继续读取后续分页。若后续分页读取失败，云桥会提示重试并保留原有模型列表。
- **工具调用历史。** 通过网关转发到 OpenAI Chat 兼容接口时，工具结果会沿用对应调用的标识，修复并行调用后继续对话可能报错的问题。
- **ZCode 桌面版。** 在 Windows 和 macOS 上可以识别 ZCode 桌面版。打开「客户端接入」中的 ZCode 桌面版指南，可按步骤在 ZCode 中手动添加自定义供应商并选择模型。

Windows x64 提供安装版、便携版和 ZIP。macOS 的 Apple 芯片和 Intel 芯片各有对应的 DMG 和 ZIP。下载后可用发布页的 `SHA256SUMS.txt` 核对文件。[下载 0.6.15](https://github.com/jxb412/yunqiao.me/releases/tag/v0.6.15) · [安装说明](https://github.com/jxb412/yunqiao.me/blob/v0.6.15/INSTALLATION.md) · [使用指南](https://github.com/jxb412/yunqiao.me/blob/v0.6.15/USER-GUIDE.md)
