# 页面 URL 与 Google 搜索日志

在部署环境设置 `ACCESS_LOG_FILE=/var/log/webvpn/access.jsonl` 和 `NAVIGATION_LOG_ENABLED=1`，重启 WebVPN。默认不开启；不需要更换代理引擎、锁文件或依赖版本。

门户监听 Scramjet 主框架已有的 urlchange 事件：记录实际观察到的目标页面路径与保留参数、Google 搜索词、前一页 URL、前一页 Google 搜索词。新标签页仅在浏览器 referrer 保留可解析的代理来源时关联前页；来源丢失时为 unknown，不虚构点击链。主框架同文档 URL 变化由引擎事件覆盖；网页未加载代理脚本、导航被阻断、直接跳出 WebVPN、停用 JS 或上报失败时可能无记录。

新的记录仍写入本地 access.jsonl，`record_type=navigation`、`evidence_source=browser_report`、`result=observed`。既有 Wisp 连接记录仍保留，不能把两者混为一条 HTTP 成功日志。账户与来源 IP由服务器现有认证会话取得，不接受浏览器填写的账号/IP；URL、时间及前页是浏览器提供的数据，可被篡改，因此不是完整、不可抵赖的审计。source_relation=previous_page_inferred 只表示前后页面关系，不证明一定发生了鼠标点击。

脱敏在浏览器发送前、服务端落盘前各执行一次：去掉用户名密码和 fragment；已知认证、邮件等敏感入口仅保留域名与 /[redacted]；查询参数仅保留内容/搜索常用字段（q、query、id、doi、page 等），其余值省略。已知密码、token、票据、邮箱、签名等参数不保存。自定义站点可能把敏感内容放在普通路径/参数内，规则不能保证识别所有语义；请按学校确认范围启用。展示的是脱敏具体 URL，不承诺逐字节原始 URL，也不采集 POST 正文、邮件内容或 Cookie。

Google 默认识别 google.com、google.com.hk 等模块列出的常用域名 `/search?q=...`；未覆盖地区域名和非URL形式的搜索需再适配。跳转到文章页面时保存文章 URL；如果前页搜索来源可取得，可一起查看 source_search_query。

接口要求有效会话与精确同源 Origin；限制24KiB请求、每账号每分钟120条，事件ID短期去重，失败不阻断页面浏览。不把这些导航数据写入安全日志或 Syslog。日志后台升级后可按记录类型、搜索词和URL筛选。

本次为本地开发；未自动修改学校服务器环境变量，真实学校/Google端到端访问仍需部署后验证。运行测试：`node --test test/navigation-log.test.js`。

Google 搜索结果标题的点击另存为 source_relation=search_result_click，支持直接链接与可识别的 Google 中转链接。对不透明的中转地址，浏览器短暂关联该次点击与代理实际观察到的目标 URL。记录可按 source_search_query 查询，表示点击或跳转，不代表目标页面加载成功。
