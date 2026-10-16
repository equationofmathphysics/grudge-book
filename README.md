# 至高王的仇恨之书 · Grudge Book

私人本机书库 + 多账号书库，互相接受的好友、仅自己可见的备注，以及延迟更新的“我被记了多少笔”统计。中文界面、九锤刻碑、筛选、废纸篓与 JSON 导入导出均可独立运行。

本仓库按 [WH Covenant Public License v1.0](LICENSE) 公开源码，与 [longtail](https://github.com/equationofmathphysics/longtail/blob/main/LICENSE) 使用完全相同的自定义许可；未宣称获得 OSI 批准。使用、修改、商业部署和传播须遵守全文约定，传播时必须保留完整、未修改的许可证。第三方依赖保留各自许可证，见 [第三方说明](THIRD_PARTY_NOTICES.md)。

- [完整架构与信任边界](docs/ARCHITECTURE.zh-CN.md)
- [安全部署与报告](SECURITY.md)
- [参与开发](CONTRIBUTING.md)

新书库默认空白。仓库不提供真实用户数据、服务实例配置、数据库或预置账户。

## 快速启动（Node.js 24+）

运行时没有第三方依赖，Node 24 自带 SQLite。

```sh
# 源码已附 public/，直接运行不需要 npm install
PUBLIC_ORIGIN=http://localhost:3000 node server/node.mjs
# 浏览器打开 http://localhost:3000
```

首次启动自动按文件顺序执行 `drizzle/*.sql`，数据保存于 `./data/grudge.sqlite`。本机模式和账号模式是两本独立书库；只有用户明确点击导入，本机内容才上传。

开发和测试：

```sh
npm ci
npm run check
# 只有修改 db/schema.ts 后才生成新的追加迁移
npm run db:generate
```

数据库迁移由 Drizzle Kit 生成，包含 SQL、快照和 journal。发布后的迁移不可修改；新变更追加迁移。`npm run build` 生成通用 Worker 和迁移，不能替代数据库迁移验证。`npm run check` 依次执行测试、构建、编译后 Worker 检查与发布内容检查。

## Docker

```sh
docker compose up -d --build
# http://localhost:3000
```

镜像使用官方 Node 24、非 root 用户，运行时无 npm 安装。Compose 只绑定宿主机回环地址，数据库在持久化卷 `grudge-data`。重建镜像不会清除卷。不要运行 `docker compose down -v`，除非确实要删除数据库。

公网部署必须使用 HTTPS 反向代理，并把 `PUBLIC_ORIGIN` 设为浏览器实际访问的完整 origin（例如 `https://book.example.com`，不要尾路径）。非回环 HTTP origin 会拒绝启动。代理的 TLS、安全升级、备份与访问控制由部署者负责。Node 本身不内置 TLS。

### 配置

| 环境变量 | 默认值 / 含义 |
|---|---|
| `PUBLIC_ORIGIN` | `http://localhost:3000`；CSRF 精确匹配，不信任 Host / X-Forwarded-Host |
| `HOST` | `127.0.0.1`；容器设为 `0.0.0.0` |
| `PORT` | `3000` |
| `DATABASE_PATH` | `./data/grudge.sqlite`；容器 `/app/data/grudge.sqlite` |
| `ENABLE_AGGREGATE` | 默认启用；显式 `false` 时所有统计只返回 locked |
| `TRUSTED_PROXY_IP` | 默认空；只信任这个精确 socket 对端地址提供的单个有效 `X-Real-IP` |

默认不信任任何转发 IP。经过代理时，用户会共用代理 IP 的注册/登录限流额度。要用于真实多用户 HTTPS 服务，必须让代理覆盖 `X-Real-IP`，并将 `TRUSTED_PROXY_IP` 设置为 Node 实际看到的代理地址。不能让客户端直接控制该头，也不能把任意公网地址列为代理。注意容器中看到的地址通常不是 `127.0.0.1`。保留代理级限流。没有正确配置时，不应把“共享 5 次注册/小时”的默认值当成可用的生产容量。

例如可信 Nginx 中设置 `proxy_set_header X-Real-IP $remote_addr;`，然后设置精确代理地址。其他代理按其官方配置覆盖相同头。数据库应放在本地持久磁盘，不建议网络共享文件系统；此版是单 Node 进程设计。

## 两种身份模式

- Sites：只使用平台注入的稳定 `oai-authenticated-user-id`，不会另设密码体系。站点访问权限需由部署者配置。每个身份得到独立记录。平台只给服务访问、不提供用户身份时，私人 API 拒绝访问。Worker 不能被直接放到允许用户伪造身份头的环境。
- 自部署：用户名 + 密码 + 服务端算术题，不需要邮箱或手机号；没有密码找回或账号恢复。忘记密码会失去账号访问，请自行安全保存密码和导出备份。Node 忽略全部 `oai-*` 平台身份头，绝不据此登录。

用户名 3–32 位 ASCII 字母/数字/下划线/点/短横线，首位是字母或数字，大小写不敏感。密码 12–128 字符，以独立随机盐和 scrypt（N=32768,r=8,p=3）存储；最多同时运行两个哈希任务。服务端注册题包含加减乘除、括号和整数除法，5 分钟过期、首次回答即消耗。算术题挡不住专门脚本，仍保留持久化限流。

连续错密码 5 次锁该用户名 30 分钟；锁定期间正确密码也不能登录。成功登录会清零连续失败次数。锁定过期后重新计数。存在和不存在的账号得到相同失败回复。每次真实账号触发锁定，保留一个不可登录、不可加好友的系统账号拥有的“小仇”审计事件，只含账号 ID、事件类型、等级和时间，不记录密码、会话令牌或题目答案，不参与好友统计。恶意尝试可能使已知用户名被暂时锁定，这是该产品规则的取舍。

注册成功/用户名已存在均返回相同通用结果，随后用户自行登录。会话令牌为 256 位随机数，数据库只存 SHA-256 摘要，绝对有效期 7 天；HttpOnly、SameSite=Strict，公网 HTTPS 下加 Secure。仅 localhost HTTP 开发不设 Secure。账号/题目/限流/系统记录保存在 SQLite，重启不重置。

## API 合约

所有响应含 `Cache-Control: private, no-store`。所有写操作必须包含精确同源 `Origin` 和 `X-Grudge-Request: 1`；JSON 请求使用 `Content-Type: application/json`。所有私人 API 还必须带 `X-Grudge-Owner: <上次打开书库时的 member.id>`。会话变成其他账号时返回 409 `account_changed`，绝不能用另一身份自动重试旧数据。

- `GET /api/session` → `{mode, user:{id,displayName,friendCode}|null}`
- 自部署 `GET /api/auth/challenge` → `{challengeId,question,expiresAt}`
- 自部署 `POST /api/auth/register` → 输入 `{username,password,displayName?,challengeId,answer}`；通用成功后需登录
- 自部署 `POST /api/auth/login` → `{username,password}`；返回 session 形状并设 Cookie
- 自部署 `POST /api/auth/logout` → 使当前会话无效
- `GET /api/notebook` → `{version:1,revision,entries,people,appliedMigrations}`
- `PUT /api/notebook` → `{expectedRevision,notebook:{version:1,entries,people,appliedMigrations}}`，原子版本比较，冲突返回 409 `revision_conflict`
- `POST /api/notebook/import` → 相同输入，按 ID/规范化人名合并，现有内容优先；所有新导入条目强制断开账号关联且不计数。重复导入没有新内容时不升 revision
- `GET /api/friends` → `{friends:[{id,displayName,alias}],incoming:[{id,displayName}],outgoing:[{id,displayName}]}`
- `POST /api/friends/requests {friendCode}`
- `POST /api/friends/requests/:id/accept` 或 `/reject`
- `PATCH /api/friends/:id {alias}`、`DELETE /api/friends/:id`
- `GET /api/aggregate` → `{status:'locked'}`，或 `{status:'ready',total,snapshotAt,nextUpdateAt}`

好友接口路径中的 ID 始终是“另一位用户的 member.id”，不是邀请 ID。没有用户搜索和任意用户读取接口。添加好友使用 128 位随机好友码；备注只向备注者本人返回。查询参数/用户选择器被拒绝。错误统一 `{error:{code,message}}`。

每本书最多 1000 条记录、1000 位本机名册成员、100 个迁移标记，正规化 JSON 最大 1 MiB。好友和待处理邀请合计每人最多 500。整本书存储 + CAS 是有意的小规模设计；大规模协作需要拆分行级数据。

## 好友计数与隐私边界

只有在双方接受好友、记录者设好私人备注后，通过好友选择器新建的非示例记录，才以稳定账号 ID 关联并计入。手填同名对象不算；修改备注不改变关联。旧条目、本机记录、导入记录、DEMO 不会自动补关联。服务器保留条目 ID 的初始来源，不能先删再重新放入同 ID 来绕过限制。人为换 ID 重写内容、虚假账号和串通无法由此机制彻底识别。

显示本人总数需要本人有至少 5 条有效关联记录，并有至少 10 位互相接受的好友，每位至少 5 条有效关联记录（可记给其其他共同同意的好友）。只有这些达标好友明确关联给本人的记录进入总数。每位达标好友不必都写过本人，所以统计门槛不是“至少十个实际来源”的匿名保证。无来源名单、内容、对方资格数字或外部查询端点。

周快照以 UTC 每周一 00:00 为边界，只使用边界前 48 小时已经存在的记录和关系。用服务器历史发布时刻，不信任客户端 createdAt/updatedAt。相同周结果固定；新记录不会即时改变显示。撤回计数、删除、移除好友，会持久锁住受影响的当前周结果，不提供删前删后差值；最早下一周期重新判断；若撤回发生在下个周期的 48 小时延迟窗口内，下个周期也保持锁定，直到快照截止时刻已经覆盖撤回。移除好友还会清除双方相关记录的计数选择并提升 notebook revision，其他打开的标签页应重新载入。

延迟、门槛和不公开来源能降低暴露，但不是差分隐私，也不能防止 10 个受控账号、朋友串通、已知背景推理、周与周之间差分或主动试探。不要把精确总数描述为“保证匿名”。部署前应评估关系场景；可用 `ENABLE_AGGREGATE=false` 关闭。

## 备份、迁移和恢复

单人导出：使用界面 JSON 导出。备份内含自己的私密文本，发送或存放前注意接收者。导入账号必须显式确认，服务器强制取消新导入条目的账号关联与计数。好友关系、备注、密码、会话和审计不会被单本 JSON 导出。

自部署完整备份（含所有用户，运维者有责任保护）：

```sh
DATABASE_PATH=./data/grudge.sqlite node server/backup.mjs /secure/path/grudge-backup.sqlite
```

脚本使用 SQLite online backup，支持运行中生成一致备份，不覆盖已有目标。备份含私密本、凭证和会话的摘要等敏感信息，应限制权限并在外部加密。不要在运行时只复制 `.sqlite` 而漏掉 WAL。恢复时停止服务、保留旧数据库及 WAL/SHM 作为撤回备份、把一致备份放到配置路径、设正确文件权限，再启动并验证。推荐恢复后使所有旧会话失效（运维者执行 `DELETE FROM sessions`），让用户重新登录。

独立服务器之间搬家可以移动完整一致 SQLite 备份，并保留相同 schema/migrations。Sites 身份不能自动转换为密码：由用户在 Sites 导出自己的书库，在独立服务器自行注册，再明确导入；不会迁移平台身份、好友关系或会话，导入记录默认不计数。未实现跨系统批量账号迁移，也没有凭空获取平台 D1 全库的工具。

## 检查和维护

`npm test` 覆盖账号隔离、CSRF、并发版本冲突、私人备注、身份伪造、数学题、锁定/审计、计数门槛、撤回、旧 ID 来源、持久化与重启。源码另含独立安全审查测试。上线前仍需在实际平台验证 D1、TLS 代理、备份恢复和浏览器界面。

限流表、过期题目、过期会话以每次最多 100 行进行清理；过旧登录失败计数也有有界清理。为周快照使用的贡献历史只有目标 ID 与数量，不存私密正文。来源账本、历史计数、审计和周结果目前不自动删减，长期运营需监控数据库大小并制定保留策略。没有邮件、短信、密码重置、账号删除、自助数据清除或管理员网页；勿宣称这些已经实现。


## 代码地图与构建输出

- `public/`：无框架浏览器界面、内联 SVG 和过程生成音效；不加载外部 CDN、字体、遥测或广告脚本。
- `server/node.mjs`、`auth-node.mjs`、`sqlite.mjs`：独立服务器、密码/会话认证与内置 SQLite。
- `server/api.mjs`、`validation.mjs`、`aggregate.mjs`：两种运行环境共用的授权、校验、好友与统计规则。
- `db/schema.ts`、`drizzle/`：声明式 schema 与追加式 SQL 迁移。
- `worker/index.mjs`：需要可信平台身份入口与 D1 绑定的可选 Worker 适配器。
- `tests/`、`scripts/verify-build.mjs`：仅使用合成数据的单元、隔离、HTTP/重启、前端和构建回归测试。

自部署 Node 服务不需要打包，也不需要第三方运行时依赖。Worker 构建输出为 `dist/server/index.js`、`dist/drizzle/`、`dist/LICENSE` 和第三方说明。仓库和构建都不包含托管项目 ID、域名或访问策略；部署者须按目标平台提供配置。Worker 的 `oai-authenticated-user-id` 仅适用于会剥离外部同名头并注入真实身份的可信入口，不可直接作为普通公开 Worker 部署。一般服务器请使用 Node 入口。

## 许可与发行

根目录 `LICENSE` 与 `public/LICENSE.txt` 保存同一份完整许可，Node 容器及 Worker 构建也携带它。页面底部可访问许可文本。重新打包、镜像、发布修改版或复制实质部分时均需保留全文。`package.json` 的 `private: true` 仅防止意外发布到 npm，不影响源码仓库公开。

贡献代码应是你有权发布的内容，并遵守本项目许可。不要提交真实笔记、备份、账户资料、访问令牌、环境文件或托管实例标识符。
