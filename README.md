<img src="assets/jayxterm.png" alt="JayXTerm" width="72" height="72">

# JayXTerm

JayXTerm 是面向 Windows 的开源 SSH / SFTP 工作台。可以在同一个窗口里维护多台服务器、查看日志、互传文件和编辑远程配置。应用默认采用软件渲染，打包后可直接在内网运行。

[下载与发布版本](https://github.com/JayBigKing/JayXTerm/releases) · [更新记录](CHANGELOG.md) · [问题反馈](https://github.com/JayBigKing/JayXTerm/issues)

## 主要功能

| 功能 | 能做什么 |
| --- | --- |
| SSH 终端 | 每窗口最多四分屏，多窗口共享会话列表。终端标签可在分屏间拖动、移到其他窗口，或复制为同目录的新连接。 |
| 阅读与搜索 | 自动标记成功、错误、警告等日志关键词；从底栏搜索当前终端和滚动历史，支持匹配高亮、上一个 / 下一个及区分大小写。 |
| 文件空间 | 每个分屏打开自己的 SSH 当前目录。支持上传、下载、删除，以及在分屏和窗口之间拖拽复制文件或目录。 |
| 远程编辑器 | 双击文本文件，用独立的 Monaco 编辑窗口打开。支持代码高亮、查找替换、UTF-8 / GBK 和远端保存冲突提示。 |
| 会话管理 | 分组、搜索、测试连接和本机加密保存密码。支持预览并导入 Xshell 备份和 OpenSSH 配置，也可导出 OpenSSH 配置。 |
| 快捷密码 | 在设置中保存带描述的加密密码，按需显示、隐藏、编辑和删除；在密码框或 Shell 密码提示处选择描述填入。 |
| 旧系统兼容 | 每条会话可独立切换 UTF-8、GBK / CP936 或 GB2312，状态栏的帮助菜单提供 Vim 编码说明。 |

## 下载和开始使用

1. 在 [GitHub Releases](https://github.com/JayBigKing/JayXTerm/releases) 查找 Windows x64 安装版、便携版和 Mac Apple Silicon DMG。运行打包后的 EXE 无需安装 Node.js。
2. 点击「新建会话」，填写主机、端口和用户名。名称留空时会自动生成，例如 `192.168.1.10:2007 · root`。
3. 双击会话连接。首次连接时核对服务器指纹，之后可用左栏浏览远程文件，或进入标题栏的「文件空间」并排操作。
4. 需要迁移会话时，打开「工作台」，选择从 Xshell 或 OpenSSH 导入。确认预览后才写入会话库。

### 常用操作

- **上传和下载**　把本地文件或目录拖入远程文件列表上传。在 Windows 上，直接拖动远程文件名或整行，可复制到桌面、资源管理器文件夹或其他 SSH 文件面板；行尾「↗」也可拖到本地。点击「↓」可选择本地位置下载。
- **文件列表与删除**　紧凑行距和分类图标区分文件夹、文本、代码、脚本、配置、图片及压缩包等类型。点击行尾垃圾桶图标，核对服务器和完整路径后确认删除。目录会递归删除，符号链接只删除链接本身；删除无法撤销。
- **复制会话及路径**　右键终端标签，选择「复制会话及路径」，建立独立 SSH 连接并自动 `cd` 到原终端的当前目录，保留当前编码。若服务器无法提供目录，先按提示同步 SSH 当前目录，再复制。
- **整体界面颜色**　在「设置」中选择颜色，标题栏、工具栏、文件面板、终端及远程编辑器都会适配；可预览、取消或恢复默认，保存后同步其他窗口。
- **终端字体与编码**　「设置 → 终端」可搜索并选择本机的西文字体和中文字体，建议西文使用等宽字体。中文默认自动回退，也可单独指定，两者共用 8–48px 字号。字体仅作用于 Shell 连接窗口，支持预览、取消和跨窗口同步；安装新字体后可点「重新读取」刷新列表。新会话默认编码在此设置，已有连接的编码仍在底栏或会话配置中修改。
- **关键词高亮**　默认将 Success / Passed / OK 标为绿色，Fail / Error / Fatal 标为红色，Warning / Timeout / Deprecated 标为黄色，Info / Debug 标为蓝色，支持中文结果词和大小写变体。「设置 → 终端」可关闭。匹配基于终端显示内容，保留复制和传输的原始文本；Vim 等全屏程序使用自身配色。日志级别参考 [RFC 5424](https://www.rfc-editor.org/rfc/rfc5424#section-6.2.1)。
- **终端搜索**　点击底栏编码左侧的「搜索」，查找当前终端及已保留的滚动历史。点击箭头或按 Enter / Shift+Enter 跳转，Aa 切换大小写匹配，Esc 关闭。搜索会高亮匹配并滚动到结果，切换标签后搜索范围随当前终端切换。
- **快捷密码本**　「设置 → 密码 → 新增密码」保存描述和密码，例如「虚拟机1」。列表默认遮盖密码，可显示、隐藏、编辑或用垃圾桶图标删除，修改即时保存。连接密码框可选择描述填入；检测到常见 Password / sudo / 中文密码提示时，会在 Shell 光标右侧显示候选，窗口边缘自动调整位置。使用 ↑/↓ 选择，Enter 或鼠标点选后填入并自动提交；Esc 关闭列表。底栏「密码本」也可主动打开并按描述筛选。快捷密码使用 Windows 系统安全存储加密，独立于自动记录的历史密码。
- **终端剪贴板**　默认在鼠标选中文字并松开后自动复制，右下角短暂显示「已复制 N 字符」；按 Ctrl+V 将剪贴板中的文本粘贴到终端，纯图片不粘贴。「设置 → 终端」可分别关闭这两个功能，保存后同步所有窗口；关闭 Ctrl+V 粘贴后，该按键恢复远端程序的控制键行为。右键菜单始终提供复制、粘贴和全选。
- **预测输入回显**　「设置 → 终端」默认开启。支持括号粘贴模式的 Shell 中，当前输入确认至少两个字符的远端回显后，后续普通 ASCII 字符会先在本地显示，同时逐键发送。服务器返回后以真实输出替换预览，不写入本地虚构历史。Tab、方向键、退格、Enter、Ctrl+C、粘贴、中文、全屏程序和密码提示等情况停止预测；一秒没有确认也会清除预览。它改善高延迟网络的输入手感，命令执行和补全仍需等待服务器。
- **会话迁移**　支持 Xshell 的 `.xts` 和 `.xsh`。可能重复的会话默认跳过，可在预览中选择更新已有或保留两条。OpenSSH 导出包含别名、主机、端口和用户名，可通过 `ssh -F jayxterm-ssh.config 别名` 使用。
- **密码和缓存**　Windows 上通过系统安全存储加密保存密码。密码历史默认关闭，可以在设置中开启。会话配置和密码保存在应用数据目录，缓存目录可在设置中更改。

## 兼容范围

- **客户端**　面向 Windows 10 / 11 x64。便携包当前未签名。Windows 资源管理器原生拖放和 Windows 显示缩放的验收进度见 [验证记录](VERIFICATION.md)。
- **连接**　当前支持直接 SSH 密码认证及 SFTP。私钥、跳板机和 MFA 尚未支持。导入 OpenSSH 配置时，含 `Include` 或 `Match` 的配置需要先整理所需的 `Host` 段。
- **远程文件**　编辑器支持不超过 2 MiB 的 UTF-8 / GBK 文本。保存需要同目录创建文件及替换原文件的权限。递归传输可保留空目录，遇到符号链接或 Windows 文件名冲突时会报错。

## 从源码构建

需要 Node.js 22.12 或更新版本，以及 Visual Studio Build Tools 的「使用 C++ 的桌面开发」工作负载。在仓库根目录运行 PowerShell 命令。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows.ps1 install
powershell -ExecutionPolicy Bypass -File scripts/windows.ps1 dev
```

运行测试并生成 Windows x64 安装包和便携版。

```powershell
powershell -ExecutionPolicy Bypass -File scripts/windows.ps1 test
powershell -ExecutionPolicy Bypass -File scripts/windows.ps1 smoke
powershell -ExecutionPolicy Bypass -File scripts/windows.ps1 package
```

构建产物位于 `.codex-cache/releases/`。开发配置、测试数据和构建缓存也位于仓库的 `.codex-cache/`。安装依赖和首次构建需要联网。

设置界面分为外观、终端、文件与存储、密码。分类与字段布局在 `index.html`，载入、预览、保存和分类导航集中在 `src/settings-panel.js`；新增选项时扩展字段列表及 `src/app-settings.cjs` 的默认值与校验即可。字体枚举、搜索与列表交互在 `src/font-picker.js`，中文字体按字符范围载入的逻辑在 `src/terminal-fonts.js`。

## 自动测试与发版

推送 `jay_version` 或主分支以及提交 Pull Request 时，GitHub Actions 会自动测试 Windows 和 macOS。

发版时，在 [Actions 的构建页面](https://github.com/JayBigKing/JayXTerm/actions/workflows/windows.yml) 点击 **Run workflow**，选择要构建的分支（`main` 或 `jay_version`）。测试通过后，Actions 会根据该分支 `package.json` 的版本号创建标签和 Release，并上传 Windows x64 安装版、便携版、Mac Apple Silicon DMG 和 SHA-256 校验文件。两个分支共用仓库的版本标签，发版前请在 `package.json` 与 `package-lock.json` 中使用尚未发布的版本号。

## 参与贡献

欢迎提交 Issue 和 Pull Request。报告问题时请附上 JayXTerm 版本、Windows 版本和复现步骤，使用脱敏的连接信息或截图。

## 许可证

JayXTerm 源码采用 [MIT 许可证](LICENSE)。第三方依赖遵循各自的许可证。
