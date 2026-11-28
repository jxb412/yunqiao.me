# 夜间上游调研与发布

Windows 任务计划程序中的 `YunQiao-Nightly-Upstream` 每天北京时间 22:30 运行。任务使用当前 Windows 用户的 GitHub 登录和模型服务。机器需要能联网且该用户已登录，锁屏可以运行；错过时间时，任务计划程序会在条件恢复后补跑。

1. 读取 cc-switch、CodexPlusPlus 和 magpie 的正式发布、默认分支提交、Issues 和评论。启用 Discussions 的仓库还会读取主题、评论及回复。每类记录保留数量、链接和最多五条跨时段样本。
2. 将有来源的反馈与云桥公开源码对照，在独立检出目录提出模型、协议或界面等受支持范围内的小改进。没有合适的改动就只生成报告。源码选择和修改基于可核对的上游链接，模型调用按本机模型服务的计费方式结算。
3. 有改动时创建夜间分支和 PR，并准备下一个补丁版本。Windows、Apple Silicon 和 Intel Mac 的 PR 检查全部通过，同一提交才可进入 `main`。检查失败的候选保留 PR 和原因。
4. 等待该提交在 `main` 上正式构建，核对各平台安装包的来源、文件大小及 SHA256，再发布到 GitHub 和官网。下载页通过已有的五分钟定时任务跟随正式更新接口。中途未完成的发布会在后续运行重试。

本机的研究报告在 `%LOCALAPPDATA%\YunQiaoNightly\reports`，各平台构建和测试结果可在 GitHub Actions 查看。发布进行中时，其进度记录在同目录下的 `pending.json`。官网发布凭据使用 Windows 当前用户加密保存在项目外。[软件下载页](https://www.yunqiao.me/downloads) · [GitHub Actions](https://github.com/jxb412/yunqiao.me/actions)

查看任务的下一次运行时间和最近退出码：

```powershell
Get-ScheduledTaskInfo -TaskName 'YunQiao-Nightly-Upstream'
```

可在项目目录运行以下命令预览真实反馈。预览会使用模型服务，报告写入本机，版本和调研进度只在正式运行时更新。

```powershell
.\scripts\run-nightly-maintenance.ps1 -StateDir "$env:LOCALAPPDATA\YunQiaoNightly" -Preview
```
