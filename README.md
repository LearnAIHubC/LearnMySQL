# LearnMySQL

LearnMySQL is a Codex skill for secure MySQL operations. It provides a bundled Node.js CLI for alias-based connections, schema inspection, guarded SQL queries, approved writes, logical backups, TLS settings, and database selection at operation time.

Read this in Chinese: [README_CN.md](README_CN.md)

## Features

- Manage MySQL server/account connections by alias instead of credential-bearing connection strings.
- Keep passwords out of chat, command arguments, environment variables, and project files.
- Store credentials through the official `mysql_config_editor` login-path mechanism.
- Keep the default database optional and select a database for each task.
- Inspect databases, tables, columns, and indexes with fixed read-only commands.
- Run guarded `SELECT`, `SHOW`, `DESCRIBE`, `DESC`, and `EXPLAIN` statements.
- Require explicit switches for writes, destructive SQL, SQL files, and backup overwrites.
- Create logical backups with safe `mysqldump` defaults.
- Support TLS verification, CA certificates, Unix sockets, and operation timeouts.
- Print concise human-readable output by default, or structured JSON with `--json`.

## Requirements

- Node.js 18 or newer.
- The official MySQL client programs: `mysql`, `mysqldump`, and `mysql_config_editor`.

On macOS with Homebrew:

```bash
brew install mysql-client
```

If you want to invoke the MySQL programs directly, add Homebrew's keg-only client directory to `PATH`. LearnMySQL also checks the standard Apple Silicon and Intel Homebrew locations automatically.

Use `mysql-ops doctor` after installation to verify all three programs. The LearnMySQL installer does not install or start a MySQL server.

## Install Into Codex

Run:

```bash
npx --yes github:LearnAIHubC/LearnMySQL
```

Then restart Codex and use `$mysql-ops`.

To update an existing installation:

```bash
npx --yes github:LearnAIHubC/LearnMySQL --force
```

The installer copies the skill into `${CODEX_HOME:-$HOME/.codex}/skills/mysql-ops` and creates a launcher at `${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops`. Add that `bin` directory to `PATH` if you want to run `mysql-ops` without the full path. If you install with `--dest`, use the launcher path printed by the installer. The Codex skill name is `mysql-ops`. The UI display name is `MySQL Ops`.

## First-Time Setup

Check the required client programs:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" doctor
```

Create a connection alias in your own terminal:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" configure app-prod \
  --host db.example.com \
  --port 3306 \
  --user app_reader \
  --ssl-mode VERIFY_IDENTITY \
  --ssl-ca /absolute/path/ca.pem \
  --description "production read-only"
```

The real password is typed only into the hidden terminal prompt. Do not pass it as a flag, connection URI, or environment variable, and do not paste it into chat.

A database is not required when creating an alias. Select one later with `--database`, or intentionally save a preferred default by adding `--database <name>` to `configure`.

For a local Unix socket, use `--socket /path/to/mysql.sock` instead of `--host` and `--port`.

## Common Commands

List sanitized aliases:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" list
```

Test a connection without selecting a database:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" ping app-prod
```

List databases, then choose one for the task:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" databases app-prod
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" tables app-prod --database app
```

Describe a table:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" describe app-prod \
  --database app \
  --table users
```

Run a read-only query:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" query app-prod \
  --database app \
  --sql "SELECT id, email FROM users ORDER BY id DESC LIMIT 20"
```

Use standard input for complex SQL:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" query app-prod \
  --database app \
  --stdin --json <<'SQL'
SELECT status, COUNT(*) AS total
FROM orders
GROUP BY status;
SQL
```

After reviewing and approving a write, run it with the required acknowledgement:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" execute app-staging \
  --database app \
  --stdin --allow-write <<'SQL'
UPDATE feature_flags
SET enabled = 1
WHERE name = 'new_checkout';
SQL
```

Create a logical backup without overwriting an existing file:

```bash
"${CODEX_HOME:-$HOME/.codex}/bin/mysql-ops" dump app-prod \
  --database app \
  --output /absolute/path/app-backup.sql
```

## Safety Model

LearnMySQL never accepts passwords through flags, `MYSQL_PWD`, connection URIs, or generated SQL files. It delegates password prompting and storage to the official `mysql_config_editor` program. MySQL describes `.mylogin.cnf` as obfuscated storage that prevents accidental cleartext exposure, not as protection from a determined attacker with access to the machine.

Alias metadata under `${CODEX_HOME:-$HOME/.codex}/mysql-ops/config.json` contains only non-secret settings such as descriptions, preferred databases, TLS modes, and timeouts. Raw host, user, and port overrides are rejected during normal alias operations.

The CLI read-only check is a syntactic guard, not a database authorization boundary. Use a dedicated least-privilege account. Writes and destructive operations require explicit acknowledgement switches, and backup files are not overwritten by default.

## Project Layout

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

## Validation

Validate the skill metadata:

```bash
python3 ~/.codex/skills/.system/skill-creator/scripts/quick_validate.py skills/mysql-ops
```

Check the CLI syntax and run the test suite:

```bash
node --check skills/mysql-ops/scripts/mysql-ops.mjs
npm test
```

The CLI tests use stub MySQL programs and do not connect to a real database.

## Packaging

Preview the npm package contents:

```bash
npm pack --dry-run
```

## Friendly Links

- [LINUX DO](https://linux.do/) - A new ideal community and gathering place for technology enthusiasts.

## License

MIT License. See [LICENSE](LICENSE).
