# 初版验证记录

2026-11-13，开发主机 macOS，Electron 42.8.1，关闭硬件加速。

已完成：

- Vite 生产构建。
- 5 项测试通过：会话校验和持久化、真实本地 SSH 密码认证 / 错误密码拒绝 / 主机指纹拒绝、UTF-8 回显、600 KB 连续输出流量控制、SFTP 单文件与嵌套目录往返、空目录、Windows 文件名和符号链接保护。
- 实际 Electron 窗口检查：通过表单保存会话和系统加密密码，磁盘中没有明文测试密码；连接真实本地 SSH 测试服务，左侧显示远程文件，右侧显示交互终端。
- 通过原生磁盘 File 对象触发拖放上传，远程收到的文件字节一致。
- 通过界面上传嵌套目录，再下载回本地，中文文件内容和空目录均保留。
- 在 macOS 交叉生成 Windows x64 便携版 EXE；检查包内 SSH 依赖、最新文件面板、传输模块、许可证均存在，应用主程序为 Windows x86-64 PE。

尚未完成：Windows 实机启动、Windows DPAPI 实测、Windows 原生资源管理器拖放与中文输入法、内网服务器兼容性、无 GPU Windows 下与 VS Code 的输入延迟对比。已提供 Windows CI 工作流，但未在本次会话触发。

截图（开发环境）：`.codex-cache/qa/overview.png`、`session.png`、`connected.png`。

## 0.1.1 终端尺寸回归

- 新增真实 SSH 时序测试先在旧代码上失败：期望 137 列 / 41 行，远端实际收到 100 列 / 30 行。
- 修复后覆盖握手前、Shell 创建期间、已连接后的三种尺寸更新，全部通过。
- 在关闭硬件加速的 Electron 中连接真实 Bash / Readline PTY，用带颜色的长路径提示符测试三种窗口宽度；输入超过两屏宽度的命令、执行后重复上 / 下键，检查命令完整换行，历史操作前后屏幕内容完全一致。此项在 macOS 运行，Windows 和用户实际服务器上的复测仍待完成。
- POSIX Bash 窗口回归可通过设置 `JAYXTERM_READLINE_QA=1` 运行 `scripts/smoke.cjs`；测试脚本依赖 Python 3 和 /bin/bash，不进入发行包。

## 0.2.0 功能回归

- 7 项自动测试通过：新增 GBK 每个拆包位置解码、ANSI / Vim 控制序列完整性、GBK 输入编码、UTF-8 / GBK 切换，真实 SSH 探测不创建 PTY，以及真实连接的 GBK 双向回显。
- 实际窗口验证：未保存会话测试成功，错误密码测试失败且不增加会话或终端标签；保存密码点击显示后正确可见，隐藏恢复掩码，关闭编辑框清空。
- 用真实 Bash / Vim 验证：同一 GBK 文件 cat 正常而 Vim termencoding=utf-8 时乱码；将 Vim termencoding 改为 cp936 后显示正确，输入中文并保存，检查文件仍为 GBK 且内容一致；切换客户端为 UTF-8 后，Vim termencoding=utf-8 也能正确读取该 GBK 文件。未直接测试 electerm 本身。
- 新增截图 `.codex-cache/qa/vim-mismatch.png`、`vim-gbk.png`，对照乱码配置和正确配置。
- 此次 GUI / Vim 检查在 macOS Electron 42.8.1、软件渲染下进行；新版本仍待 Windows 和实际内网老系统验收。

## 0.3.0 多窗口

- 真实 Electron 多窗口检查：会话修改同步；输出不发送到无归属窗口；移动到已有窗口、移出新窗口、合并回原窗口，认证次数保持不变，历史、编码和 SFTP 路径保留；不同窗口尺寸下 PTY 与终端一致。
- 在 GBK Vim 正在编辑时移出和合并，再编辑保存，文件内容及 GBK 编码仍正确。
- 故障注入：目标恢复失败时回退到原窗口，SSH 连接仍可输入；关闭空闲窗口或另一个有连接的窗口，不影响当前连接。
- 后台协议回归：暂停交接输出期间，ACK 不得提前恢复流，解除暂停后输出完整。
- 本机回环传输测量：120 次回显（两组均将被测终端窗口置前，待界面空闲后测量），单窗口与增加 3 个空闲窗口对比；数据见 `.codex-cache/qa/multiwindow-metrics.json`。它只测传输到界面事件的时延，不包含绘制，不代表 Windows 内网或持续高负载性能。
- 多窗口检查命令：设置 `JAYXTERM_MULTIWINDOW_QA=1` 后运行 `scripts/smoke.cjs`；可与 `JAYXTERM_READLINE_QA=1`、`JAYXTERM_VIM_QA=1` 一起运行。窗口管理截图：`.codex-cache/qa/window-manager.png`。
- 本版在 macOS 软件渲染下检查，Windows 实机多窗口及多显示器仍待用户验收。

## 0.3.1 剪贴板

- 使用真实系统剪贴板和 Chromium 键鼠输入：终端全选后 Ctrl+Shift+C、Ctrl+C 均复制到系统；没有选择时 Ctrl+C 仍向 SSH 发送 0x03，不被复制逻辑吞掉。
- Ctrl+V、Ctrl+Shift+V 的 UTF-8 中文粘贴只发送一次；Shift+Insert 的 GBK 中文粘贴检查原始 SSH 输入字节与 CP936 编码相同。
- 多行文本在 bracketed paste 模式下保留起止标记，CRLF / LF 正确归一化。实际构造右键原生菜单并验证复制、粘贴回调。
- 剪贴板测试使用临时测试文字，结束时恢复原有文本、HTML、RTF 和图片等常用格式，不保存原剪贴板内容到磁盘。
- 检查命令：设置 `JAYXTERM_CLIPBOARD_QA=1` 运行 `scripts/smoke.cjs`。本次在 macOS Electron 软件渲染环境中模拟 Windows 快捷键验证，Windows 实机仍需验收。

## 0.3.2 仅右键剪贴板

- 移除终端复制粘贴的自定义快捷键及原生菜单 accelerator；阻止终端浏览器 copy / paste 事件，保留右键菜单。
- 实际 Electron 检查：右键全选、复制、UTF-8 / GBK 粘贴和带括号标记的多行粘贴；菜单没有快捷键提示。选中终端文字后 Ctrl+C 仍发送 0x03 且不更改剪贴板；Ctrl+V 发送 0x16，不粘贴系统内容。测试后恢复原剪贴板常用格式。

## 0.5.0 远程文件编辑

- 启用 `JAYXTERM_EDITOR_QA=1` 运行 Electron 验收，验证双击在独立窗口打开多个文件、主窗口终端保持可用、拒绝二进制、快捷键保存、保留 GBK 和 CRLF、选择编码重新读取及转存 UTF-8、远端修改冲突时保留本地草稿，以及取消关闭未保存文件。原有四分屏和多窗口验收也已通过。
- 保存通过同目录临时文件替换原文件，要求 SFTP 服务允许替换。会保留标准权限位和所有者，SFTP v3 不提供保留 ACL、扩展属性或硬链接关系所需的信息。
- 在 macOS Electron 软件渲染下联调，跨平台打包 Windows x64 便携版。Windows 实机和实际内网 SFTP 服务待验收。

## 0.5.2 文件编辑器修复

- Electron 验收覆盖 Tab / Shift+Tab、聚焦选区配色、SFTP 通道关闭后的再次保存，以及服务器在替换目标文件时改写修改时间的连续保存。真实内容冲突仍会阻止覆盖并保留草稿。
- 7 项单元和 SSH 集成测试通过，四分屏、双栏文件和多窗口回归通过。Windows 实机和用户内网服务器仍待验证。

## 0.5.3 分屏文件空间

- Electron 本机验收逐一对比切换前后的一至四个分屏坐标及尺寸，验证每格跟随其终端标签，空分屏保持空状态，返回终端后 SFTP 路径仍可从侧栏访问。
- 跨分屏将目录拖到另一台服务器指定的子目录，并校验嵌套文件内容和空目录。原有跨窗口二进制传输、多窗口和远程编辑器回归通过。
