# Telegraph Hub

**基于 Cloudflare Workers、D1 和 Telegram Bot API 的轻量文件托管服务。**

提供网页上传、媒体管理、公开文件直链、PDF 在线预览，以及使用 HMAC-SHA256 签名认证的 REST API。

## 功能概览

- 上传 JPG、PNG、GIF、WEBP、BMP、SVG、MP4、AVI、MOV、WEBM、PDF 等文件，并返回托管直链。
- 前端支持拖放/粘贴上传、图片压缩选项、结果链接格式与近期上传记录。
- 媒体库支持分页、卡片/表格视图、类型筛选、搜索、预览和批量删除。
- PDF 浏览器访问时可在线预览；?raw=true 返回原文件，?download=1 下载，?embed=1 用于嵌入。
- 管理员使用登录会话；REST API 使用独立共享密钥签署请求，并拒绝过期时间戳和 nonce 重放。

## 部署配置

1. 创建 Telegram Bot，并把它加入用于存储文件的频道/群组，记录 Bot Token 和 Chat ID。
2. 创建 Cloudflare D1 数据库，并将数据库绑定到 Worker，绑定变量名使用 DATABASE。Worker 首次运行时会自动创建/迁移所需表。
3. 将 _worker.js 部署为 Cloudflare Worker。
4. 在 Worker 的 Variables and Secrets 中配置下表。请将凭据设为 Secret；尤其不要公开 TG_BOT_TOKEN、PASSWORD 或 API_SECRET。

| 变量 | 必需 | 说明 |
| --- | :---: | --- |
| DOMAIN | 是 | 文件直链所用域名，通常为绑定到 Worker 的自定义域名。 |
| TG_BOT_TOKEN | 是 | Telegram Bot Token。 |
| TG_CHAT_ID | 是 | Bot 有权向其中发送消息的频道/群组 ID。 |
| USERNAME | 是 | 管理员用户名，也用于 API 签名请求的用户名。 |
| PASSWORD | 是 | 管理员登录密码。请不要将它复用于 API_SECRET。 |
| API_SECRET | 调用 API 时必需 | API HMAC 密钥，至少 32 个字符。应使用独立随机值，不要复用 PASSWORD。可用 openssl rand -hex 32 生成。 |
| DATABASE | 是 | D1 数据库绑定。绑定名称不是 DATABASE 时，请将此值设为实际绑定变量名。 |
| ADMIN_PATH | 否 | 媒体库 URL 路径；默认为 admin。 |
| SESSION_SECRET | 否 | 管理员会话签名密钥；默认为 PASSWORD。建议设置独立随机值。修改后现有会话失效。 |
| ENABLE_AUTH | 否 | 设为 true 时，首页上传和 /upload、/transfer 也要求登录；默认 false。API 始终要求 HMAC 签名，不受此项影响。 |
| MAX_SIZE_MB | 否 | 单文件大小上限，默认为 20 MB。 |

## 页面与路由

| 路径 | 用途 |
| --- | --- |
| / | 上传中心。ENABLE_AUTH=true 时需要登录。 |
| /<ADMIN_PATH> | 媒体库管理页面，始终需要登录；默认 /admin。 |
| /login、POST /logout | 登录与退出。登录成功后使用 HttpOnly、Secure、SameSite=Lax 的会话 Cookie。 |
| /docs | REST API 文档页面；媒体库与上传中心也提供“文档”入口。 |
| /upload | 网页上传处理端点；ENABLE_AUTH=true 时需要登录。表单字段为 file。 |
| /transfer | 远程 URL 转存；ENABLE_AUTH=true 时需要登录。 |
| /<file-path> | 已托管文件直链；PDF 另支持下表中的查询参数。 |

ENABLE_AUTH 控制的是前台上传，不控制媒体库或版本化 API 的认证。未配置 ENABLE_AUTH=true 时，任何人都可以使用公开上传页面。

### PDF 链接参数

| 参数 | 行为 |
| --- | --- |
| 默认 | 在浏览器中使用 PDF 在线预览器。 |
| ?raw=true | 返回原始文件内容。 |
| ?download=1 | 以附件形式下载。 |
| ?embed=1 | 以适合 iframe/弹窗的嵌入模式打开预览器。 |

## REST API

所有 API 路径以 /v1/api 为前缀。API 始终要求 HMAC-SHA256 签名；Basic Auth 和浏览器登录 Cookie 不适用于这些接口。请通过 HTTPS 调用，并将 API_SECRET 安全保存在客户端。

| 方法 | 路径 | 请求 |
| --- | --- | --- |
| POST | /v1/api/files | multipart/form-data，必填 file 文件字段。 |
| DELETE | /v1/api/files?url={fileUrl} | 删除指定文件。url 可放在查询参数或 JSON body 中；JSON body 也接受 address。 |
| POST | /v1/api/transfer | JSON body：{"url":"https://..."}，远程获取并托管受支持的文件。 |

成功上传/转存返回 {"data":"文件直链"}。删除返回 {"success":true,"deleted":1}；找不到文件时 deleted 为 0。缺失/无效认证返回 401。上传超限返回 413；其他错误通常返回含 error 字段的 JSON。

### 签名规则

每个请求必须包含以下请求头：

~~~text
X-Auth-Username: <USERNAME>
Authorization: HMAC-SHA256 <timestamp>:<nonce>:<signature>
~~~

- timestamp 是 Unix 秒时间戳，服务器只接受与当前时间相差不超过 5 分钟的请求。
- nonce 是每次请求新生成的 32–128 个十六进制字符；服务器使用 D1 记录并拒绝重放。
- body_hash 是实际 HTTP 请求体字节的 SHA-256 十六进制小写摘要；空请求体使用空字节计算。Multipart 请求必须对完整编码后的 multipart body 求摘要。
- 签名是 HMAC-SHA256(API_SECRET, canonical) 的 64 位十六进制结果。canonical 由以下 UTF-8 文本用换行符连接；末尾没有额外换行：

~~~text
TELEGRAPH-HMAC-SHA256
<USERNAME>
<HTTP_METHOD 大写>
<URL pathname + ?query（无 query 时不含问号）>
<timestamp 原始十进制文本>
<nonce 小写>
<body_hash 小写>
~~~

下面的 Python 示例使用 requests 先准备实际 HTTP 请求（包括 multipart 边界），再对准备好的请求体和 URL 签名：

~~~python
import hashlib
import hmac
import secrets
import time
from urllib.parse import urlsplit

import requests

API_BASE = "https://your-domain.example/v1/api"
USERNAME = "YOUR_USERNAME"
API_SECRET = "YOUR_API_SECRET"  # 从安全的 Secret 存储读取

def signed_request(method, url, **kwargs):
    headers = dict(kwargs.pop("headers", {}))
    headers["X-Auth-Username"] = USERNAME
    prepared = requests.Request(method, url, headers=headers, **kwargs).prepare()

    body = prepared.body or b""
    if isinstance(body, str):
        body = body.encode("utf-8")
    parts = urlsplit(prepared.url)
    target = parts.path or "/"
    if parts.query:
        target += "?" + parts.query

    timestamp = str(int(time.time()))
    nonce = secrets.token_hex(16)
    body_hash = hashlib.sha256(body).hexdigest()
    canonical = "\n".join([
        "TELEGRAPH-HMAC-SHA256", USERNAME, method.upper(),
        target, timestamp, nonce, body_hash,
    ])
    signature = hmac.new(
        API_SECRET.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256
    ).hexdigest()
    prepared.headers["Authorization"] = f"HMAC-SHA256 {timestamp}:{nonce}:{signature}"
    return requests.Session().send(prepared)

# 上传
with open("image.png", "rb") as file:
    response = signed_request("POST", API_BASE + "/files", files={"file": file})
print(response.status_code, response.json())

# URL 转存
response = signed_request(
    "POST", API_BASE + "/transfer", json={"url": "https://example.com/image.jpg"}
)
print(response.status_code, response.json())

# 删除（查询参数也会纳入签名）
response = signed_request(
    "DELETE", API_BASE + "/files",
    params={"url": "https://your-domain.example/path/image.png"},
)
print(response.status_code, response.json())
~~~

安装示例依赖：python -m pip install requests。每个 HTTP 尝试（包括重试）都必须重新生成 timestamp、nonce 和签名；不要重发同一组签名头。

## 安全说明

- USERNAME / PASSWORD 用于后台登录；管理会话由 SESSION_SECRET 签名，默认有效期 7 天。
- API 使用单独的 API_SECRET 和请求签名。请求体摘要避免请求内容被替换；时间戳限制签名有效期；D1 nonce 表用于拒绝签名重放。
- Basic Auth 只是编码而非加密，因此 API 不再接受 Basic Auth；所有认证凭据都应仅在 HTTPS 上发送。
- 若 API 请求返回 503，请确认 D1 绑定可用，并已配置至少 32 字符的 API_SECRET。

## License

MIT，详见 LICENSE。
