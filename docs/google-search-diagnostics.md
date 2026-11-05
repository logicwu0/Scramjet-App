# Google 搜索排查（2026-11-05）

用户现象：首次普通窗口可搜索，隔天普通窗口显示 Google unusual traffic 页面；无痕窗口可用。页面显示出口202.112.53.113。此为上游风控响应，不等于本地CAS拒绝，也不能排除代理改变请求后间接触发。

服务器同出口、无用户Cookie、简化URL及用户旧参数URL都返回200，但正文IncompleteBody，未验证完整搜索结果；不能声称根因已确定或已修复。现有auth-client.js每30秒检查会话，失效跳转登录。原版锁定CookieStore另有Max-Age未处理、load(object)未恢复等问题，尚未证明与本次Google风控有因果关系，未进行猜测性修改或清空数据。

临时public/search-diagnostics.js只采集Google .com/.com.hk搜索/挑战页状态、Sec-Fetch字段枚举、Authorization是否存在、Cookie数量，经认证保护的/api/proxy-diagnostics写本机服务journal。每Worker最多10条，服务端每分钟最多30条；不写目标完整URL、查询参数、Cookie值、授权值、账号；不写安全Syslog源文件。排查结束后移除此临时模块。

查看：journalctl -u webvpn --since '10 minutes ago' --no-pager | rg 'WebVPN search diagnostic'

本次同时按用户要求恢复MathSciNet Set-Cookie过滤，与main的行为一致；不恢复响应头内容打印，不改证书选项、正文缓冲或依赖版本。

## reCAPTCHA正文截断定位与修复

同一服务器Wisp+Epoxy链路：google.com及recaptcha.net的api.js均完整200；gstatic recaptcha__en.js声明852683字节，原实现identity与identity-close分别只读802816、770048字节后IncompleteBody。隔离Wisp对照只改变TCP EOF处理，两次都完整852683字节。原AsyncQueue.close清空未消费字节；现TCP关闭调用close(true)，保留已有数据，释放等待入队的生产者，并将EOF排在这些字节之后。默认中断close语义不变。

保留Wisp 0.4.1版本，通过pnpm补丁及锁文件管理；runtime-integrity覆盖net.mjs和websocket.mjs。新增队列满/积压/中断与真实1MiB慢消费者TCP测试。此修复解决已复现的脚本传输缺陷，不承诺消除Google风控或代表完整验证码交互已验收。
