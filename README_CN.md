# LearnMySQL

LearnMySQL 是一个用于安全执行 MySQL 操作的 Codex skill。它内置 Node.js CLI，支持按别名连接、结构检查、受保护的 SQL 查询、经确认的写操作、逻辑备份、TLS 设置，以及在执行任务时选择数据库。

English version: [README.md](README.md)

## 功能

- 使用 MySQL 服务器/账号别名，避免在对话中出现带凭据的连接字符串。
- 密码不进入聊天、命令参数、环境变量或项目文件。
- 通过官方 `mysql_config_editor` login-path 机制保存凭据。
- 默认数据库可选，可在每次任务执行时选择数据库。
- 使用固定的只读命令检查数据库、表、字段和索引。
- 受保护地执行 `SELECT`、`SHOW`、`DESCRIBE`、`DESC` 和 `EXPLAIN`。
- 写入、破坏性 SQL、SQL 文件和覆盖备份都需要显式确认参数。
- 使用安全的 `mysqldump` 默认参数创建逻辑备份。
- 支持 TLS 身份验证、CA 证书、Unix Socket 和操作超时。
- 默认输出简洁的人类可读结果，使用 `--json` 输出结构化 JSON。

## 运行要求

- Node.js 18 或更高版本。
- 官方 MySQL 客户端程序：`mysql`、`mysqldump` 和 `mysql_config_editor`。

macOS 使用 Homebrew 时运行：

```bash
brew install mysql-client
```

如果希望直接调用这些 MySQL 程序，可以把 Homebrew 的 keg-only 客户端目录加入 `PATH`。LearnMySQL 也会自动检查 Apple Silicon 和 Intel Mac 的标准 Homebrew 安装位置。

安装后运行 `mysql-ops doctor`，确认三个程序都可用。LearnMySQL 安装器不会安装或启动 MySQL 服务端。

## 安装到 Codex

运行：

```bash
npx --yes github:LearnAIHubC/LearnMySQL
```

然后重启 Codex，使用 `$mysql-ops`。

更新已有安装时运行：

```bash
npx --yes github:LearnAIHubC/LearnMySQL --force
```

安装器会把 skill 复制到 `${CODEX_HOME:-$HOME/.codex}/skills/mysql-ops`，并创建 `${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops` 启动器。如果想直接运行 `mysql-ops`，把这个 `bin` 目录加入 `PATH`。如果使用 `--dest` 自定义安装目录，以安装器输出的 launcher 路径为准。Codex 内部 skill 名是 `mysql-ops`，界面显示名是 `MySQL Ops`。

## 首次配置

检查所需客户端程序：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" doctor
```

在自己的终端中创建连接别名：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" configure app-prod \
  --host db.example.com \
  --port 3306 \
  --user app_reader \
  --ssl-mode VERIFY_IDENTITY \
  --ssl-ca /absolute/path/ca.pem \
  --description "production read-only"
```

真实密码只在终端隐藏提示中输入。不要把密码作为命令参数、连接 URI 或环境变量，也不要粘贴到聊天中。

创建别名时不要求填写 database。可以在后续操作中使用 `--database` 选择，也可以在确实需要默认数据库时，在 `configure` 中添加 `--database <名称>`。

连接本机 Unix Socket 时，使用 `--socket /path/to/mysql.sock`，不要同时使用 `--host` 和 `--port`。

## 常用命令

列出脱敏后的连接别名：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" list
```

不选择数据库，直接测试连接：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" ping app-prod
```

先列出数据库，再为当前任务选择一个：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" databases app-prod
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" tables app-prod --database app
```

查看表结构：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" describe app-prod \
  --database app \
  --table users
```

执行只读查询：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" query app-prod \
  --database app \
  --sql "SELECT id, email FROM users ORDER BY id DESC LIMIT 20"
```

复杂 SQL 建议通过标准输入传入：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" query app-prod \
  --database app \
  --stdin --json <<'SQL'
SELECT status, COUNT(*) AS total
FROM orders
GROUP BY status;
SQL
```

审核并确认写操作后，使用必需的确认参数执行：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" execute app-staging \
  --database app \
  --stdin --allow-write <<'SQL'
UPDATE feature_flags
SET enabled = 1
WHERE name = 'new_checkout';
SQL
```

创建逻辑备份，默认不会覆盖已有文件：

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" dump app-prod \
  --database app \
  --output /absolute/path/app-backup.sql
```

## 安全模型

LearnMySQL 不接受通过命令参数、`MYSQL_PWD`、连接 URI 或生成的 SQL 文件传入密码。密码提示和保存交给官方 `mysql_config_editor`。MySQL 官方将 `.mylogin.cnf` 定义为用于避免意外明文泄露的混淆存储，而不是防御能够访问本机的攻击者的加密保险箱。

`${CODEX_HOME:-$HOME/.codex}/mysql-ops/config.json` 只保存描述、首选数据库、TLS 模式和超时等非敏感元数据。使用连接别名执行正常操作时，不允许临时覆盖原始 host、user 或 port。

CLI 的只读检查只是语法保护，不等于数据库权限边界。应使用专用的最小权限账号。写入和破坏性操作需要显式确认参数，备份文件默认不覆盖。

## 项目结构

```text
bin/install.mjs
package.json
skills/mysql-ops/
|-- SKILL.md
|-- agents/openai.yaml
`-- scripts/mysql-ops.mjs
test/
|-- install.test.mjs
`-- mysql-ops.test.mjs
```

## 验证

验证 skill 元数据：

```bash
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/mysql-ops
```

检查 CLI 语法并运行测试：

```bash
node --check skills/mysql-ops/scripts/mysql-ops.mjs
npm test
```

CLI 测试使用模拟的 MySQL 程序，不会连接真实数据库。

## 打包

预览 npm 包内容：

```bash
npm pack --dry-run
```

## 友情链接

- [LINUX DO](https://linux.do/) —— 新的理想型社区，技术爱好者的聚集地。

## 许可证

MIT License。见 [LICENSE](LICENSE)。
