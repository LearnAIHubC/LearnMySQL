---
name: mysql-ops
description: Secure alias-based MySQL operations through the official MySQL command-line clients and mysql_config_editor. Use when Codex needs to configure or test a MySQL connection, inspect databases/tables/columns/indexes, run SQL queries or approved writes, execute SQL files, create logical backups, use TLS connection settings, or handle Chinese requests involving MySQL, 数据库连接, 连库, 查库, 查表, 执行 SQL, 导入, 导出, 备份, or 恢复. Do not use for PostgreSQL or non-MySQL databases.
---

# MySQL Ops

Use the bundled Node.js CLI for MySQL operations. Treat each named MySQL `login-path` alias as a server/account connection, not as a database binding. Keep credentials outside chat and command arguments, then select the relevant connection and database from task context.

## Hard rules

- Never ask the user to paste a password, token, client key, or connection URI containing credentials into chat.
- Never read, copy, decode, or print `.mylogin.cnf`. Let `mysql_config_editor` and official MySQL clients access it.
- Never pass passwords through `--password=<value>`, `MYSQL_PWD`, a connection URI, an environment dump, or a generated SQL file.
- Never override an alias with raw `--host`, `--user`, or `--port` during normal operations.
- Do not run `configure` for the user when it will prompt for a password. Show the command and ask the user to run it in their own terminal.
- Select a connection automatically only when one alias exists or the task and alias metadata make the target unambiguous. If multiple plausible aliases remain, ask before accessing data.
- Do not require a default database on the connection. Select a database per task; never auto-select `information_schema`, `mysql`, `performance_schema`, or `sys` unless the user explicitly requests a system schema.
- Prefer a dedicated least-privilege, read-only database account for inspection. The CLI read-only check is a syntactic guard, not a database authorization boundary.
- Obtain explicit user approval before `execute`, `run-file`, `remove`, restoring a dump, overwriting a backup, or any other write/destructive operation. State the target alias and database.
- Prefer `--stdin` for SQL containing quotes, `$`, backticks, personal data, tokens, or other sensitive literals. Do not echo sensitive SQL.
- Never add MySQL `--force` to an import: stop on the first SQL error.

## Locate the CLI

Use:

```bash
MYSQL_OPS="${CODEX_HOME:-$HOME/.codex}/skills/mysql-ops/scripts/mysql-ops.mjs"
node "$MYSQL_OPS" doctor
```

Require Node.js 18+ and the official `mysql`, `mysqldump`, and `mysql_config_editor` programs. If `doctor` reports a missing program, ask the user to install the official MySQL client tools for their operating system, then rerun it.
On macOS, the CLI discovers Homebrew's standard keg-only `mysql-client` locations automatically; do not edit shell startup files solely for this skill.

## Configure connections

Create an alias in the user's own terminal. The real password is entered only at the hidden prompt:

```bash
node "$MYSQL_OPS" configure app-prod \
  --host db.example.com \
  --port 3306 \
  --user app_reader \
  --ssl-mode VERIFY_IDENTITY \
  --ssl-ca /absolute/path/ca.pem \
  --description "production read-only"
```

Do not add `--database` unless the user intentionally wants to save a preferred default. It is optional and can always be overridden per operation. For a local Unix socket, use `--socket /path/to/mysql.sock` instead of `--host` and `--port`. Use `--no-password` only for an account intentionally configured without a password or with socket-based authentication.

`mysql_config_editor` stores the password in its native `.mylogin.cnf` login-path file and masks it when printing configuration. MySQL documents this as obfuscation that prevents accidental cleartext exposure, not protection against a determined attacker with access to the machine. Keep the host secured and the account least-privileged.

## Select a connection and database

Choose targets in this order:

1. Run `list --json` to inspect sanitized aliases and descriptions.
2. Use the only alias automatically when exactly one exists. With several aliases, choose the one explicitly named by the user or clearly matched by its description/default metadata; otherwise ask.
3. Run `databases <alias> --json` when the task does not name a database and the alias has no saved default.
4. Exclude system schemas by default. Select the sole remaining business database automatically; when several remain, use the task's schema/table names to identify the target, or ask if it is still ambiguous.
5. For writes, restores, dumps, or destructive work, state and confirm the final alias and database even when selection appears unambiguous.

Inspect only sanitized connection metadata and server availability:

```bash
node "$MYSQL_OPS" list --json
node "$MYSQL_OPS" show app-prod --json
node "$MYSQL_OPS" ping app-prod --json
node "$MYSQL_OPS" databases app-prod --json
```

Connecting, pinging, listing databases, and queries using fully qualified names do not require a selected default database.

## Inspect schemas

Use fixed, read-only commands where possible:

```bash
node "$MYSQL_OPS" tables app-prod --database app --json
node "$MYSQL_OPS" describe app-prod --database app --table users --json
```

Run a single read-only statement with `query`. It accepts `SELECT`, `SHOW`, `DESCRIBE`, `DESC`, or non-`ANALYZE` `EXPLAIN`; it rejects multiple statements and common locking or server-file side effects.

```bash
node "$MYSQL_OPS" query app-prod --database app \
  --sql "SELECT id, email FROM users ORDER BY id DESC LIMIT 20" --json
```

For complex SQL, use a quoted heredoc:

```bash
node "$MYSQL_OPS" query app-prod --database app --stdin --json <<'SQL'
SELECT status, COUNT(*) AS total
FROM orders
WHERE created_at >= CURRENT_DATE - INTERVAL 7 DAY
GROUP BY status;
SQL
```

## Execute approved writes

After explicit approval, use `execute --allow-write`. Add `--allow-destructive` only when the reviewed SQL contains operations such as `DROP`, `TRUNCATE`, account/privilege changes, `SET GLOBAL`, or server shutdown/reset commands.

```bash
node "$MYSQL_OPS" execute app-staging --database app --stdin --allow-write <<'SQL'
UPDATE feature_flags
SET enabled = 1
WHERE name = 'new_checkout';
SQL
```

Execute a reviewed SQL file only after approval. `run-file` requires both acknowledgements because a file may contain arbitrary statements:

```bash
node "$MYSQL_OPS" run-file app-staging \
  --database app \
  --file /absolute/path/change.sql \
  --allow-write \
  --allow-destructive
```

## Back up and restore

Create a logical dump without overwriting an existing file by default:

```bash
node "$MYSQL_OPS" dump app-prod \
  --database app \
  --output /absolute/path/app-backup.sql \
  --json
```

The dump uses `--single-transaction`, `--quick`, `--skip-lock-tables`, routines, events, triggers, `--set-gtid-purged=OFF`, and `--no-tablespaces`. Explain that transaction consistency covers transactional tables such as InnoDB and that concurrent DDL can still invalidate a dump. Use `--overwrite` only after explicit approval.

Treat restore as a destructive `run-file` operation. Verify the target alias/database and backup before running it.

## Connect through SSH

When MySQL is reachable only through SSH, use `$learn-ssh` to start a local tunnel first, then configure the MySQL alias against `127.0.0.1` and the local forwarded port. Keep SSH credentials in LearnSSH and MySQL credentials in the MySQL login path; do not combine them in chat.

## Handle output and failures

- Add `--json` for machine-readable envelopes containing `success`, operation metadata, exit code, stdout, and stderr.
- Report the exact alias and database used, but never reveal raw credentials or secret-bearing files.
- On connection failure, run `doctor`, then `show <alias>`, then `ping <alias>`. Check DNS/tunnel reachability and TLS settings without weakening TLS silently.
- Do not change `VERIFY_IDENTITY` or `VERIFY_CA` to a weaker mode without user approval and a clear warning.

## Official references

- `mysql_config_editor`: <https://dev.mysql.com/doc/refman/8.4/en/mysql-config-editor.html>
- `mysql` options and batch mode: <https://dev.mysql.com/doc/refman/8.4/en/mysql-command-options.html>
- `mysqldump`: <https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html>
