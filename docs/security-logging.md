# 认证与异常日志

安全日志仅记录认证失败与异常事件，不再记录登录成功及正常退出。另有仅本地保存的目标连接访问日志；两类日志均不记录完整 URL、密码、Cookie、CAS 票据或异常堆栈。学校 CAS 页面中输错密码的事件由学校记录，本应用记录的是回调无效、票据校验失败等本地可观察事件。

环境变量：

- `SECURITY_LOG_FILE=/var/log/webvpn/security.jsonl`：每行 JSON；未配置时输出到服务标准输出。写文件失败时回退服务日志，不放行失败的认证。
- `SECURITY_TRUST_LOOPBACK_PROXY=1`：仅当连接来自回环地址，才读取合法的单个 `X-Real-IP`。Nginx 必须覆盖此头为 `$remote_addr`，应用继续只监听回环地址。不能直接信任客户端 `X-Forwarded-For`。

记录字段：UTC 时间（带 Z）、唯一事件 ID、category、应用/主机、事件、级别、账号、来源 IP、结果和固定原因码。未知账号为 null，不从客户端输入冒认账号。过期事件的 IP 为建立会话时的 IP。

事件覆盖：回调和票据失败、退出请求拒绝、未登录资源访问、Wisp 握手拒绝、服务端客户端套接字错误、升级处理错误、应用请求处理错误、会话过期/被学校撤销、服务启停。不记录正常页面访问或正常代理连接；不等于所有上游网站的 HTTPS 错误均可检测，也不提供爬虫识别。

## Ubuntu 部署

准备目录 `/var/log/webvpn`（webvpn:adm，0750）、安全日志（webvpn:adm，0640）；systemd 的 ProtectSystem=strict 下通过 drop-in 设置 `ReadWritePaths=/var/log/webvpn`。只向 webvpn 主服务加载日志环境变量。

`deploy/rsyslog/35-webvpn-security.conf` 通过 imfile 读取这一个文件，进入独立 ruleset，按 RFC5424 格式写本机 `/var/log/webvpn-security-syslog.log`，不进入默认系统日志规则。此文件预建为 syslog:adm 0640。配置前检查主机是否已加载 imfile，勿重复加载；执行 `rsyslogd -N1` 后再重启 rsyslog。

学校提供接收地址、端口、TCP/UDP/TLS 和格式要求后，在此 ruleset 内启用对应 omfwd action。模板中的 TCP action 默认注释，不向任何外部地址发送。TCP 可配置磁盘辅助队列、重试；UDP 无可靠送达保证。TLS 需要学校提供信任链和接收端名称，不能关闭证书校验。队列容量有限，监控磁盘和接收失败；event_id 可供接收端去重。

`deploy/rsyslog/webvpn-security.logrotate` 按日轮转，保留14份、压缩；20M阈值在 logrotate 被调度时检查，不是硬容量上限。应用每次追加重新打开文件，不用 copytruncate。

查询：

```sh
sudo tail -n 20 /var/log/webvpn/security.jsonl
sudo tail -n 20 /var/log/webvpn-security-syslog.log
sudo journalctl -u webvpn -u rsyslog --since '10 minutes ago'
```

本地 Syslog 格式验证通过不代表已与学校接收端联调；未提供接收信息时保持外发关闭。现有 Nginx 运维日志不纳入此 Syslog ruleset。

当前模板 Syslog 信封使用 `local6.info`；JSON 内的 `severity` 区分 info、warning、error。接收端若要求以 Syslog PRI 直接分级，可在拿到格式要求后调整模板/规则。


## 仅本地访问日志

`ACCESS_LOG_FILE=/var/log/webvpn/access.jsonl`，未设置则不开启；写入失败只报告固定错误，不把访问记录回退到 stdout/Syslog。此文件不在 rsyslog imfile 的采集范围内。权限与安全文件相同，纳入本机轮转。

一行对应一个 Wisp 目标连接的结果，字段包括 UTC 时间、事件ID、CAS账号、来源IP、目标主机、端口、TCP/UDP及结果。`connected` 表示 TCP 已连接，或 UDP 已设置对端（不保证远端响应），不是页面成功加载；`failed` 表示建立失败；`not_established/closed_before_connect` 表示策略拒绝或在连接建立前关闭，不能据此区分两者。一个网页可能建立多个域名连接，一个连接也可能承载多个请求，因此不是完整URL/逐页面日志。

实现使用锁定 Wisp 的每连接 TCPSocket/UDPSocket 注入选项，包装其原生 socket；不修改依赖或转发协议。原生类路径相对当前固定版本的 ESM 入口解析，将来升级依赖时需复测。账号/IP取自服务端认证会话，不能由前端上报冒认。

```sh
sudo tail -n 20 /var/log/webvpn/access.jsonl
```

此前测试已产生的登录成功/退出历史记录保留；本次部署后不再新增此两种事件。
