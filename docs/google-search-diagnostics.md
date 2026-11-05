# Google 搜索排查（2026-11-05）

用户现象：首次普通窗口可搜索，隔天普通窗口显示 Google unusual traffic 页面；无痕窗口可用。页面显示出口202.112.53.113。此为上游风控响应，不等于本地CAS拒绝，也不能排除代理改变请求后间接触发。

服务器同出口、无用户Cookie、简化URL及用户旧参数URL都返回200，但正文IncompleteBody，未验证完整搜索结果；不能声称根因已确定或已修复。现有auth-client.js每30秒检查会话，失效跳转登录。原版锁定CookieStore另有Max-Age未处理、load(object)未恢复等问题，尚未证明与本次Google风控有因果关系，未进行猜测性修改或清空数据。

临时public/search-diagnostics.js只采集Google .com/.com.hk搜索/挑战页状态、Sec-Fetch字段枚举、Authorization是否存在、Cookie数量，经认证保护的/api/proxy-diagnostics写本机服务journal。每Worker最多10条，服务端每分钟最多30条；不写目标完整URL、查询参数、Cookie值、授权值、账号；不写安全Syslog源文件。排查结束后移除此临时模块。

查看：journalctl -u webvpn --since '10 minutes ago' --no-pager | rg 'WebVPN search diagnostic'

本次同时按用户要求恢复MathSciNet Set-Cookie过滤，与main的行为一致；不恢复响应头内容打印，不改证书选项、正文缓冲或依赖版本。
