# 南昌大学 CAS 本地联调

开发分支：`feat/ncu-cas`。本分支新增 CAS 2.0 登录接入，不修改主分支，不代表已完成学校验收。

## 本地怎么运行

使用 Node.js 22.23.4 或以上版本。已有依赖的当前工作目录可直接运行，在两个终端分别执行：

```sh
npm run mock:cas
```

```sh
npm run dev:cas
```

浏览器访问 http://127.0.0.1:8080 ，点击“使用模拟学生登录”。首页右上角“账户 / 退出”可查看虚拟身份、退出。
模拟账户只有 `student-demo`，不填写学校账号或密码。两个服务均只监听本机。

自动化验证：

```sh
npm run test:cas
# 两个本地服务启动后：
npm run test:cas:live
```

现有锁定的 Scramjet/Epoxy 依赖未升级。新增固定版本 `saxes@6.0.0`（及其 xmlchars 依赖）解析 CAS XML。
当前上游 Scramjet 锁定下载地址返回 404，因此尚未完成空目录的完整依赖安装验证；不要删除现有 node_modules 或重新生成整个锁文件。
当前本地新增依赖通过独立临时项目取得并复制，锁文件只合入新增依赖记录。正式构建前需恢复原锁定制品的可下载来源并验证 frozen-lockfile 安装。

## 接学校时配置什么

复制 `.env.ncu.example` 为 `.env.ncu.local`（已排除 Git），根据学校登记结果填写：

```dotenv
CAS_LOCAL_TEST=0
HOST=127.0.0.1
PORT=8080
APP_ORIGIN=https://学校批准的WebVPN域名
CAS_BASE_URL=https://cas.ncu.edu.cn:8443/cas/
CAS_SESSION_SECONDS=3600
CAS_ONLINE_CHECK=1
```

通过 HTTPS 反向代理接入，保留 Host、Origin、Cookie，并正确转发 `/wisp/` WebSocket。启动：

```sh
node --env-file=.env.ncu.local src/index.js
```

学校需登记应用 service 回调路径 `https://批准域名/auth/callback`，允许该路径携带随机 `nonce` 查询参数；不能将某一次 nonce 固定为登记值。提交给 CAS 的 service 与后台校验时完全一致。
如启用文档的单点注销，登记 `https://批准域名/auth/slo`。学校提供测试账号、确认 service 匹配规则及 `login/userOnlineDetect` 接口权限后，才能完成真实联调。
本地也可用学校认可的测试 HTTPS 域名联调，但本次使用模拟 CAS，尚未验证真实学校票据、账号属性、证书链和网络可达性。

## 当前实现

- `/auth/login` 跳转 CAS；`/auth/callback` 验证浏览器绑定的 nonce，并由后端向 `/serviceValidate` 校验 ST，不收集学校密码。
- 票据成功后创建随机服务器会话，正式模式 Cookie 使用 Secure、HttpOnly、SameSite=Lax；会话默认一小时，重启失效。
- 未登录禁止访问应用资源、CA 下载接口和 Wisp；WebSocket 单独校验会话、Origin 和路径。退出或到期关闭现有连接，不设置每会话的代理连接数上限。
- `/auth/account` 提供退出表单；`/auth/logout` 校验来源和 CSRF 后销毁会话，再跳转 CAS 注销。
- `/auth/slo?callback=jsonpcallback` 按文档返回 JSONP，校验回调名称，注销当前浏览器会话。
- 可选在线检测向 `/login/userOnlineDetect` 提交原 service、ST 和用户名。定时任务每 30 秒尝试启动一轮、逐会话检测，不重叠执行；校验失败或 CAS 不可用会注销会话。用户较多或 CAS 慢时一轮可能超过 30 秒，当前不能承诺 30 秒内全量注销。
- CAS XML 限制大小、深度、命名空间和用户节点，禁止 DTD；请求有超时、禁止重定向，保留正常 TLS 证书校验。

## 上线前仍须完成

1. **认证页面与代理内容的浏览器来源隔离。** 现有 Scramjet 页面、Service Worker 和被代理内容共用来源；不能把 HttpOnly 或本次登录拦截当成完整隔离。需设计独立认证入口/代理来源和会话交换机制，再验证恶意代理页面无法调用认证接口或滥用用户会话。本分支仅供本地联调，尚不能作为生产安全验收版。
2. 学校实际登录、退出、会话到期、属性字段和在线检测联调。JSONP 跨站注销可能受 SameSite/第三方 Cookie 策略限制，应验证在线检测等补偿措施，不能保证仅 JSONP 即完整单点退出。
3. 资源授权、网络出站策略和审计。当前认证成功的用户共享同一资源范围；尚未新增按学生记录目标站点的审计。本分支禁止代理访问回环和私网，校内资源应通过显式允许列表设计后开放。上线应配置出站防火墙和管理网隔离，不能只依赖应用 IP 检查。
4. HTTPS 和访问日志脱敏。反向代理不要记录 `/auth/callback` 的查询参数、票据或 Cookie；现有服务日志不是完整用户审计。配置登录限流、容量监控，多实例部署需共享会话及跨实例断连机制。
5. 恢复锁定依赖制品来源，完成干净安装、部署和资源访问回归。当前测试验证认证流程与代理连接鉴权，不等于所有学术站点兼容性验证。

## 本次验证记录（2026-11-01）

本机 Node.js 26.13.0 下 11 项认证测试及 1 项真实 HTTP/WebSocket 集成测试通过；ESLint、语法检查、Git 空白检查通过。
浏览器实际验证了模拟登录、首页、账户和退出，发现并修复 WebKit 下退出表单 Origin 与 CSP 重定向兼容问题。
尝试临时下载 Node.js 22.23.4 未能完成，已停止下载；因此本次尚未在该运行时复测，也未修改全局 Node。

## 对接依据

- [厂商 CAS ST 接入文档](https://authx-service.dev2.supwisdom.com/docs/authx/index.html#/guide/cas/st/guide)
- [厂商 CAS 安全建议](https://authx-service.dev2.supwisdom.com/docs/authx/index.html#/guide/cas/st/security-considerations)
- 学校 CAS： https://cas.ncu.edu.cn:8443/cas/

## 真实学校入口探测（2026-11-02）

已新增本机忽略配置 `.env.ncu.local`，使用学校 CAS 地址，应用暂监听 `http://127.0.0.1:8081`，避免与 8080 模拟服务混淆。启动命令：

```sh
node --env-file=.env.ncu.local src/index.js
```

浏览器从本机应用实际跳转至学校 `/cas/login` 后，学校返回“未认证授权的服务”“不允许使用CAS来认证您访问的目标应用。”并明确显示该 service 不在 service registry 中。
本次提交的回调为 `http://127.0.0.1:8081/auth/callback?nonce=<随机值>`。尚未输入真实账号，未取得 ST，未验证学校 serviceValidate。
下一步需学校登记批准的测试 service（确认是否接受本机 HTTP 地址，否则使用认可的 HTTPS 测试域名），匹配动态 nonce 参数；学校授权后再进行账号登录及后端票据校验。
`CAS_LOCAL_TEST=1` 仅为本机 HTTP Cookie/回调配置，并不表示使用模拟认证；实际 CAS 服务由 `CAS_BASE_URL` 指向学校。

## 服务器模拟认证配置

服务器测试环境使用真实 HTTPS 域名时，示例配置如下（替换域名）：

```dotenv
CAS_LOCAL_TEST=0
HOST=127.0.0.1
PORT=8080
APP_ORIGIN=https://vpn-test.example.org
CAS_BASE_URL=https://vpn-test.example.org/cas/
CAS_MOCK_BACKEND_URL=http://127.0.0.1:9080/cas/
MOCK_CAS_PORT=9080
CAS_SESSION_SECONDS=3600
CAS_ONLINE_CHECK=0
```

用同一配置分别启动应用和 `scripts/mock-cas.mjs`，模拟服务始终只监听回环地址。Nginx 的 `/cas/login` 和 `/cas/logout` 转发到模拟服务，其余应用路径转发到 8080，WebSocket 按需升级。票据校验通过 CAS_MOCK_BACKEND_URL 的回环通道进行，不需要将 `/cas/serviceValidate` 暴露公网。
测试入口必须限制访问（如额外访问密码或测试来源 IP 白名单），覆盖页面、模拟登录和 WebSocket；模拟账户本身不验证身份。HTTPS 访问仍使用 Secure Cookie，不要为了部署将 CAS_LOCAL_TEST 设为 1。
接入学校时，修改 CAS_BASE_URL 为学校地址，**删除 CAS_MOCK_BACKEND_URL**，关闭模拟认证服务及反向代理的模拟路径，再进行真实认证联调。现有来源隔离待办仍然适用。

## WebSocket 认证兼容修复（2026-11-03）

测试入口使用 Nginx Basic Auth 时，浏览器 WebSocket 可能不携带同源页面的 Basic 凭据。已复现：有效 CAS Cookie 的握手仍被 Nginx 返回 401 和 Basic challenge。Wisp 路径应交由应用校验会话与 Origin，不能再依赖弹窗认证：

```nginx
location = /wisp/ {
    auth_basic off;
    proxy_pass http://127.0.0.1:8080;
    include snippets/ncu-proxy.conf;
}
```

此例使用部署中的 ncu-proxy.conf 转发 Host、Upgrade、Connection 等头。应用必须保留 authorizeUpgrade；只有这个精确路径免除 Basic Auth，页面及模拟登录仍受测试入口保护。已验证无 Basic 凭据但带有效会话可以连接，退出断连和未登录拒绝继续有效。
按用户要求移除原固定 8 条连接上限，不再新增每会话的连接数量限制。拒绝响应分别使用 401/session_required、403/origin_mismatch、404/invalid_path，并记录不包含 Cookie、票据或账号的原因。保留会话与来源校验以及退出断连。不能根据历史应用层 401 单独断言用户遇到的是连接数超限。
