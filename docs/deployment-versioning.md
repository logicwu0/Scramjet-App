# 部署版本管理

南昌大学代码只在 feat/ncu-cas 分支维护。先本地修改、测试、提交并推送；确认 GitHub 分支 SHA 后，由服务器下载该固定 SHA 的源码归档。不能直接部署未提交工作区、移动分支的未知最新代码或只修改服务器文件。

每次部署：备份当前源码与配置；从 GitHub 固定提交归档生成逐文件 SHA256 清单；对照服务器，额外源码文件移到备份；同步归档全部源码；验证后重启并跑登录/代理/退出回归；验证成功后记录 DEPLOYED_COMMIT 和 DEPLOYED_MANIFEST.json。清单必须由可信 GitHub 归档生成，不能以服务器当前文件反向生成来掩盖差异。

```sh
cd /opt/webvpn
node scripts/verify-deployment.mjs
cat DEPLOYED_COMMIT
```

校验覆盖全部仓库文件、代码目录多余文件及 deploy/runtime-integrity.json 中的关键运行依赖指纹。证书、密钥、学校接收地址、运行环境变量、日志、node_modules其余平台依赖不属于源码一致性比较；保留在部署环境，不提交密码。运维配置由仓库模板管理，环境具体值单独备份。

当前保留锁定依赖版本。Epoxy 补丁按已验证的实际运行文件重建，并更新补丁哈希，避免仓库遗留调试代码在重新安装时被意外应用。服务器遗留但未生效的 Wisp drain-eof 补丁移入备份，不纳入运行配置。安装必须使用冻结锁文件；若锁定上游下载地址失效，应先解决供应问题，不能擅自改为最新版本或声称全新安装已验证。

2026-11-05后续：reCAPTCHA排查实际复现Wisp EOF丢尾部字节。新的@mercuryworkshop__wisp-js@0.4.1.patch已正式纳入pnpm，涵盖满队列待入队数据的顺序处理；这与此前移走的未启用临时补丁不同。Wisp仍为0.4.1，运行指纹新增websocket.mjs。
