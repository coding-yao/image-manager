# Comfy Image Manager

基于 **Electron + React + TypeScript + electron-vite** 的 ComfyUI 图片管理器框架。

## 本地开发

需要 Node.js 22.12+（推荐 Node.js 24 LTS）及 npm。

```powershell
npm install
npm run dev
```

已安装依赖时直接运行 `npm run dev`。开发模式支持 React 热更新，主进程和 preload 变化也会触发重启。

```powershell
npm run typecheck   # TypeScript 检查
npm test            # 目录扫描测试
npm run build       # 构建到 out/
npm run preview     # 启动构建后的桌面应用
npm run test:smoke  # 启动真实 Electron，验证核心流程；截图位于 artifacts/
npm run pack        # 生成当前平台免安装应用目录，输出到 release/
npm run dist        # 生成当前平台分发包；Windows 默认为 NSIS 安装程序
```

Electron 首次安装和打包可能需要联网下载二进制。若提示 Electron 未正确安装，可执行 `npx install-electron --no` 后重试。分发前请配置自己的应用图标、作者、应用 ID 和签名；当前未配置代码签名。跨平台分发请在对应操作系统上构建和验证。

本机已安装 Electron 时，可用 `npm run pack -- --config.electronDist=node_modules/electron/dist` 复用本地运行时。Windows 打包后可用 `node scripts/smoke.mjs "release\win-unpacked\Comfy Image Manager.exe"` 验证实际 EXE。

依赖审计：当前 `npm audit` 报告打包工具 electron-builder 的 minimatch 传递依赖存在 6 项中等级告警，均属于开发 / 打包依赖，运行时依赖无告警。暂未采用审计工具建议的跨大版本降级；正式分发前应重新审计并更新打包工具。

## 已实现

- 使用系统对话框选择图片目录，默认递归包含子目录，可手动刷新。
- 浏览 PNG、JPEG、WebP、GIF、BMP、AVIF；具体解码能力取决于系统及 Electron，失败时显示占位提示。GIF 缩略图为静态图。
- 缩略图按需加载，最多同时生成 4 张，内存缓存最多 128 张；每次显示 120 个卡片，可加载更多。
- 文件名 / 相对路径筛选、修改时间与名称排序。
- 点击图片查看原图、相对路径、文件大小及修改时间；Esc 关闭预览。
- 按需解析 PNG 原图中的 ComfyUI `prompt` / `workflow`，展示节点、标题、输入参数和原始 JSON；支持按节点类型、ID、标题和参数文本筛选当前图片的节点。
- 空目录、读取失败、损坏图片和权限异常的反馈。

直接读取原目录，不复制、移动、删除图片，不写入源图片。选择的目录暂不持久化，重启后重新选择；新增图片需要点击刷新。

## 结构与边界

```text
src/
  main/
    index.ts               窗口生命周期、受限 IPC、本地图片协议
    services/library.ts    递归目录扫描与文件索引
    services/metadata.ts   PNG 文本块解析与 ComfyUI 节点归一化
  preload/index.ts         暴露目录操作与按图片 ID 查询元数据
  shared/library.ts       跨进程数据类型与 IPC 通道
  renderer/
    index.html             页面入口与 CSP
    src/App.tsx            图片库、筛选、预览
    src/MetadataPanel.tsx  工作流节点、参数及原始 JSON 查看
    src/styles.css         深色桌面界面
tests/library.test.ts      目录扫描测试
tests/metadata.test.ts     元数据格式及异常处理测试
scripts/smoke.mjs          真实 Electron 端到端验证
```

渲染进程启用沙箱和上下文隔离、关闭 Node 集成；图片协议只接受当前目录索引中已登记的文件 ID，界面无法通过任意路径参数读取文件。参考 [Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security) 与 [IPC 文档](https://www.electronjs.org/docs/latest/tutorial/ipc)。扫描跳过符号链接，不主动跟随链接目录。

目前扫描结果一次性返回、保存在内存；尚未加入文件监控、流式扫描、扫描取消与持久化索引。图库达到数万张时，建议接入后台索引、增量事件和列表虚拟化。

## 原图工作流解析

参考用户提供的 `ComfyUI-工作流元数据查看器.html` 的逻辑，将“提取 PNG 文本 → 解析 JSON → 展示节点”拆为主进程服务和 React 组件。未引入该网页的 HTML 拼接方式；元数据作为文本渲染，不执行其中的脚本。

- 支持 PNG `tEXt`、`zTXt` 和压缩 / 非压缩 `iTXt` 文本块，识别 `prompt` 与 `workflow`，兼容中文及 UTF-8 文本。
- `prompt` 是按节点 ID 组织的执行图，并非单一提示词字符串；`workflow` 是包含节点位置、连线、控件等数据的编辑器工作流。两者分别解析，坏 JSON 不影响另一个有效字段；只有 workflow 时也可查看节点。
- 优先显示 prompt 的 `_meta.title`，其次显示 workflow 的 `title`；合并相同 ID 的节点，保留仅存在于 workflow 的节点。自定义节点的 widgets 仅显示原始值，不猜测参数名和正反提示词。
- 原始 JSON 保留完整字符串（含无法解析的 JSON）；workflow 连线与其他字段可以在原始 JSON 中查看。目前是数据查看器，没有绘制节点连线画布，也没有执行工作流。
- 按需读取原图文件，跳过像素数据块；只读不修改。校验文本块 CRC，检查块边界和 PNG 结束标记；不进行完整的像素或全部 PNG 规范验证。
- 单个文本块 / 解压后文本最多 8 MiB，累计文本预算 16 MiB（含读取和解压计数），块数最多 20,000；JSON 最大深度 64、遍历值最多 100,000 个。超限或损坏时给出提示。文件读取失败通过 IPC 返回错误。无内嵌数据时不尝试从像素推导工作流。
- 主进程只接受当前目录中已登记的图片 ID，界面不能传入任意文件路径；切换或关闭图片后忽略迟到的解析结果。

格式依据：[PNG 规范](https://www.w3.org/TR/png/) 和 [ComfyUI 保存元数据实现](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api/latest/_ui.py)。

## 后续扩展

图库顶部目前仍仅筛选文件名和路径；**跨目录 / 子目录提示词全文搜索尚未实现**。详情内的搜索只针对当前图片的节点与参数。

1. 沿工作流连接关系提取正向 / 反向提示词，同时保留原始 JSON；不同工作流、自定义节点的格式可能不同。
2. 为目录及所有子目录建立 SQLite 索引，按路径、修改时间和大小增量更新，再添加全文搜索与索引进度界面。
3. WebP / JPEG 需要分别适配容器与 EXIF，目前会明确提示仅支持 PNG 元数据。新版 ComfyUI 动画 PNG 的自定义 `comf` 块尚未适配。
