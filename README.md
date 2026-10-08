<div align="center">

# ☁️ Telegraph Hub

**基于 Cloudflare Worker + D1 数据库与 Telegram Bot API 构建的现代化边缘网盘与文件分发平台**

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Cloudflare D1](https://img.shields.io/badge/Database-Cloudflare_D1-F38020?logo=sqlite&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Telegram Bot](https://img.shields.io/badge/Storage-Telegram_Bot_API-24A1DE?logo=telegram&logoColor=white)](https://core.telegram.org/bots/api)
[![TailwindCSS](https://img.shields.io/badge/UI-TailwindCSS-06B6D4?logo=tailwindcss&logoColor=white)](https://tailwindcss.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-emerald.svg)](LICENSE)

<p align="center">
  极速轻量 · 全格式托管 · 在线 PDF 预览 · 块状/表格双重视图 · 原名存储 · 边缘缓存 · 独立安全鉴权
</p>


</div>

---

## ✨ 核心特性

### 📤 极速全格式文件托管
- **全格式支持**：全面支持各类常用图片（JPG、PNG、GIF、WEBP、SVG、BMP 等）、视频（MP4、MOV、WEBM 等）以及各类文档与二进制归档文件。
- **便捷投递**：支持原生文件选择、桌面拖拽上传以及剪贴板截图直接粘贴上传（`Ctrl + V`）。
- **轻量压缩**：前端内置可选的图片轻度无损压缩加速，默认开启，上传前自适应减小体积。
- **多格式链接生成**：一键生成直链（URL）、Markdown、HTML 以及 BBCode 代码，并支持一键批量复制全部链接。

### 📄 智能 PDF 在线预览
- **多端在线预览器**：内置基于 Mozilla PDF.js 的独立 HTML5 渲染器，配备完整 CJK 中文字体包支持，在微信内置浏览器、安卓、iOS Safari 及桌面端均能即开即读。
- **全功能阅读交互**：支持上一页/下一页、页码直达输入、放大/缩小、适合宽度自适应、日间/夜间模式以及全屏查看。
- **智能分流机制**：
  - 浏览器访问直接进入在线阅读模式；
  - 附带 `?raw=true` 直接获取纯净二进制流；
  - 附带 `?download=1` 强制触发文件附件下载；
  - 附带 `?embed=1` 支持无边框模态弹窗内嵌。

### 🖼️ 现代化媒体管理中心
- **双视图自由切换**：支持**块状卡片视图**（大图视觉网格）与**表格列表视图**（紧凑管理）单键无缝切换，视图偏好自动记忆于本地。
- **原始文件名记录**：D1 数据库自动记录并持久化文件的原始名称（`originalName`），卡片与列表优先展示真实文件名，支持实时模糊搜索匹配。
- **精准类型过滤**：支持「全部 / 图片 / 视频 / PDF / 其他」快速分类筛选。
- **安全操作联动**：仅对支持预览的格式显示在线预览按钮；原链新标签打开采用防冒泡隔离，直达原生链接；支持批量选中、格式化批量导出与双重确认彻底删除。

### 🔐 企业级安全与鉴权
- **独立登录体系**：提供独立的登录与退出认证页面，通过 HMAC-SHA256 签名生成安全的 `HttpOnly`、`Secure`、`SameSite=Lax` 会话 Cookie（7 天有效期）。
- **双模访问控制**：后台管理中心始终强制登录；可通过配置 `ENABLE_AUTH=true` 自由锁定前台上传页与上传接口，未登录一键拦截。
- **API 兼容性**：保留对标准 HTTP Basic Auth 认证的全面兼容，方便通过第三方脚本或客户端 API 调用。

### ⚡ 极致边缘性能
- **边缘缓存加速**：集成 Cloudflare Cache API 全球边缘节点缓存，静态文件就近命中秒级响应。
- **Range 分片流加载**：完整支持并透传 HTTP Range 请求（206 Partial Content），大文件与视频支持进度拖动，PDF 支持分页按需流式拉取。
- **全局 CORS 友好**：原生支持全套跨域资源共享及 `OPTIONS` 预检处理，外链引用无阻碍。

---

## 🚀 部署步骤

### 1. 准备 Telegram 存储凭据

1. **获取 Bot Token**：
   - 在 Telegram 中搜索找到官方机器人 [@BotFather](https://t.me/BotFather)；
   - 发送 `/newbot` 指令，按照指引设定机器人的名称与用户名；
   - 记录保存获取到的 **Bot Token**（格式如：`123456789:ABCdefGHIjklMNOpqrsTUVwxyz`）。
2. **获取频道 / 群组 Chat ID**：
   - 新建一个 Telegram **频道**（或群组），将刚才创建的 Bot 添加进该频道并赋予**管理员权限**；
   - 向该频道内随意发送一条测试消息，并将该消息转发给 [@getidsbot](https://t.me/getidsbot)；
   - 查看回复信息中 `Origin chat` 下方的 ID（通常以 `-100` 开头，如 `-1001234567890`），即为 **Chat ID**。

---

### 2. 创建 Cloudflare D1 数据库

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)；
2. 依次进入 **Workers & Pages** → **D1 SQL 数据库**，点击 **创建数据库**；
3. 设定数据库名称（推荐命名为 `tgfile`），建议区域选择 **亚太地区（Asia-Pacific）** 获取最佳延迟表现；
4. 点击保存创建。

> 💡 **提示**：数据库表结构会在 Worker 首次运行时由系统自动创建并无损迁移，无需手动执行 SQL。若需手动初始化，可在控制台执行：
> ```sql
> CREATE TABLE IF NOT EXISTS media (
>     url TEXT PRIMARY KEY,
>     fileId TEXT NOT NULL,
>     messageId INTEGER,
>     createdAt INTEGER,
>     originalName TEXT,
>     davPath TEXT,
>     isFolder INTEGER DEFAULT 0,
>     mimeType TEXT,
>     size INTEGER,
>     updatedAt INTEGER,
>     directEnabled INTEGER DEFAULT 0,
>     directCreatedAt INTEGER
> );
> ```

---

### 3. 创建 Cloudflare Worker

1. 在 Cloudflare 控制台进入 **Workers & Pages** → **概述**，点击 **创建应用程序** → **创建 Worker**；
2. 为 Worker 拟定一个名称（如 `telegraph-hub`），点击 **部署**；
3. 部署成功后，点击 **继续处理项目** 进入详情设置面板。

---

### 4. 绑定 D1 数据库

在 Worker 详情页面，依次点击 **设置** → **绑定**（Bindings），点击 **添加** → 选择 **D1 数据库**。支持以下两种绑定方式（任选其一）：

- **方式一：直接绑定（推荐）**
  - **变量名称**：直接命名为 `DATABASE`
  - **D1 数据库**：选择在步骤 2 创建的数据库（如 `tgfile`）
  - *无需在环境变量中额外配置 `DATABASE` 变量。*

- **方式二：通过环境变量间接指定**
  - **变量名称**：可自定义为任意名称（如 `tgfile`）
  - **D1 数据库**：选择对应的数据库
  - *需在下一步的环境变量中添加 `DATABASE=tgfile`，Worker 会自动识别该映射。*

点击 **部署** 保存生效。

---

### 5. 配置环境变量与机密

进入 Worker **设置** → **变量和机密**（Variables and Secrets），根据需要添加以下环境变量后点击部署：

| 变量名 | 必填 | 默认值 | 示例值 | 说明 |
| :--- | :---: | :---: | :--- | :--- |
| `DOMAIN` | **是** | - | `img.yourdomain.com` | 为图床绑定的自定义域名或 Workers 域名 |
| `TG_BOT_TOKEN` | **是** | - | `123456789:ABCdefGHI...` | 步骤 1 获取的 Telegram Bot Token |
| `TG_CHAT_ID` | **是** | - | `-1001234567890` | 步骤 1 获取的存储频道/群组 ID |
| `USERNAME` | **是** | - | `admin` | 管理后台登录用户名 |
| `PASSWORD` | **是** | - | `YourStrongPassword` | 管理后台登录密码 |
| `DATABASE` | 否 | `DATABASE` | `tgfile` | 实际 D1 绑定变量名（仅当 D1 绑定变量名称不为 `DATABASE` 时配置） |
| `ADMIN_PATH` | 否 | `admin` | `admin` | 管理后台访问路径（如配置为 `admin`，则访问路径为 `/admin`） |
| `SESSION_SECRET` | 否 | 继承密码 | `随机生成的高强度字符串` | HMAC 会话签名密钥，修改后已有登录会话将立即失效 |
| `ENABLE_AUTH` | 否 | `false` | `false` | 前台上传页是否强制要求登录鉴权（`true` 或 `false`） |
| `MAX_SIZE_MB` | 否 | `20` | `20` | 单文件最大限制（单位：MB，Telegram Bot API 上限为 20MB） |

---

### 6. 部署代码与绑定域名

1. 在 Worker 页面右上角点击 **编辑代码**；
2. 将本项目中的核心文件 [`_worker.js`](_worker.js) 的全部源码复制粘贴替换编辑器中的内容；
3. 点击右侧的 **部署**（Deploy）按钮；
4. 进入 Worker 的 **设置** → **域和路由**，点击 **添加** → **自定义域**，输入您在 Cloudflare 解析的个人域名，等待 SSL 证书颁发完成即可正式使用。

---

## 📖 访问路径与接口规范

### 常用路径

- **前台上传中心**：`https://你的域名/`
- **后台管理系统**：`https://你的域名/admin`（或自定义的 `ADMIN_PATH`）
- **独立登录页面**：`https://你的域名/login`
- **登出操作接口**：`POST https://你的域名/logout`
- **文件上传接口**：`POST https://你的域名/upload`（表单字段名为 `file`）
- **接口上传（必须认证）**：`POST https://你的域名/api/upload`，使用 HTTP Basic Auth 或登录会话，表单字段 `file`，可选 `path=/项目/`
- **直链管理**：`GET/POST/DELETE https://你的域名/api/links`；管理页面为 `/links`
- **系统设置**：`/settings`（需要登录）

### 网盘与 WebDAV

首页现在是网盘文件管理器，文件仍然保存到 Telegram 存储频道，D1 记录文件索引与文件夹路径。上传文件时可通过表单字段 `path` 指定目标文件夹，例如 `path=/项目/`。Telegram 中的文件消息 caption 会同时记录 WebDAV 文件夹地址和文件直链；在网页中重命名或通过 WebDAV `MOVE` 移动文件时，会直接调用 Telegram `editMessageCaption` 更新原消息。

新上传文件默认不会启用公网直链，只有在网盘中点击“开启直链”或调用直链 API 后，随机直链才可访问。`/links` 页面集中展示所有已启用的直链。

在网盘页面中，可直接拖动文件到任一文件夹行来移动文件；文件夹地址、D1 索引和 Telegram 原消息 caption 会一起更新。每个文件行都有独立的“开启直链”按钮，点击后立即生成并复制该文件的直链，无需再填写路径。

文件管理器支持文件、文件夹及混合多选。可使用表头全选，随后批量复制路径、开启直链、移动或删除；选中父文件夹与其中的子项时，系统会自动合并为一次目录操作，避免重复处理。批处理使用受保护的 `POST /api/files`，请求体包含 `action`、`paths`，移动操作另传 `destination`。

网盘首页采用 OpenList 风格的文件管理布局：侧边导航、面包屑、搜索与紧凑文件表格。每个文件行的“开启直链”按钮紧邻“重命名”；直链已开启时该按钮会变为“关闭直链”。

WebDAV 根地址为 `https://你的域名/dav/`（兼容 `/webdav/`），始终使用 `USERNAME` / `PASSWORD` 进行 HTTP Basic Auth（与 `ENABLE_AUTH` 无关）。支持 `PROPFIND`、`MKCOL`、`GET`、`HEAD`、`PUT`、`DELETE` 和 `MOVE`，可直接在 Windows、macOS、Linux 的 WebDAV 客户端中挂载。网页端文件列表使用 `GET /api/files?path=/文件夹/`，修改路径使用 `PATCH /api/files`，请求体示例：

```json
{"path":"/旧文件夹/报告.pdf","newPath":"/归档/报告.pdf"}
```

### 链接参数控制规范

托管生成的文件直链（如 `https://你的域名/randomId.pdf`）支持以下 URL 查询参数自由调节输出方式：

| 参数 | 适用格式 | 说明 |
| :--- | :--- | :--- |
| *默认访问* | 全部 | 浏览器访问时按类型自动匹配（图片/视频/PDF 默认内联预览；其他格式提示下载） |
| `?raw=true` | PDF / 全部 | 绕过前端在线预览器，强制输出原始二进制流（适合原生调用、客户端解析） |
| `?download=1` | 全部 | 强制输出 `Content-Disposition: attachment` 标头，触发浏览器另存为下载 |
| `?embed=1` | PDF | 开启无边框/自适应高度模式，专门适配 iframe 或模态弹窗内嵌调用 |

---

## ❓ 常见问题排查 (FAQ)

### Q1: 管理后台打开提示 Error 1101 或服务提示？
Worker 已内置完善的错误捕获与提示页面。请重点检查：
1. **D1 数据库绑定**：检查 D1 绑定变量名是否为 `DATABASE`；如果使用了其他绑定变量名（如 `tgfile`），确认是否在环境变量中设置了 `DATABASE=tgfile`；
2. `USERNAME` 与 `PASSWORD` 是否已在环境变量中正确填写；
3. 如果自定义了 `ADMIN_PATH`，请确认访问路径与配置保持一致。

### Q2: 上传文件提示“超过限制”或上传失败？
Telegram Bot API 对非本地部署的 Bot 服务端设置了单文件最大 **20MB** 的严格下载上限。因此 `MAX_SIZE_MB` 建议保持在 `20` 以内；同时请确保 Bot 已被加入对应频道并拥有管理员权限。

### Q3: PDF 文件在部分移动端或微信中显示空白或直接下载？
本版本已内置全新的 Mozilla PDF.js 在线渲染层。直接通过浏览器或微信内置环境打开 PDF 直链时会自动进入在线阅读器，完全规避移动端浏览器不支持 PDF 插件的问题。

---

## 📝 更新日志

> **最近更新**: 2026-09-11
> - 📄 新增内置 HTML5 PDF.js 智能在线预览器，支持多端自适应缩放与 CJK 字体解析
> - 🖼️ 媒体管理中心新增「块状卡片视图」与「表格列表视图」单键无缝切换与本地记忆
> - 🏷️ 数据库新增 `originalName` 字段，媒体管理中心优先展示并支持检索真实原始文件名
> - 🎯 优化媒体卡片操作权限：仅支持预览的格式渲染预览按钮，修复原链打开的事件冒泡问题

<details>
<summary><b>查看更多历史更新日志</b></summary>

### 2026-01-19
- 代码架构精简与响应逻辑重构。

### 2025-08-24
- 修复第三方 CDN 静态资源下线导致的页面加载异常。

### 2024-12-18
- 全新升级管理中心视觉交互与深浅色模式。
- 取消前端硬编码类型限制，由环境变量统一控制文件大小上限。

### 2024-12-13
- 引入哈希校验机制避免相同文件重复上传。
- 优化前端画布压缩算法与上传效率。
- 删除接口 `/delete-images` 增加完整的身份鉴权校验。

### 2024-09-29
- 全面集成 Cloudflare Cache API 边缘层缓存能力。

### 2024-09-13
- 正式接入基于 Telegram Bot API 的高可靠文件通道。

</details>

---

## 📄 开源协议

本项目基于 [MIT License](LICENSE) 协议开源，欢迎提交 Issue 与 Pull Request 共同完善。
