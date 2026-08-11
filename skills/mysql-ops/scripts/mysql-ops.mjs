#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const APP = 'mysql-ops';
const CODEX_ROOT = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const DATA_DIR = path.join(CODEX_ROOT, APP);
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const MAX_BUFFER = 64 * 1024 * 1024;
const SSL_MODES = new Set(['DISABLED', 'PREFERRED', 'REQUIRED', 'VERIFY_CA', 'VERIFY_IDENTITY']);
const PROTOCOLS = new Set(['TCP', 'SOCKET', 'PIPE', 'MEMORY']);
const HOMEBREW_MYSQL_CLIENT_DIRS = process.platform === 'darwin'
  ? ['/opt/homebrew/opt/mysql-client/bin', '/usr/local/opt/mysql-client/bin']
  : [];

function usage() {
  return `mysql-ops

Usage:
  mysql-ops doctor
  mysql-ops configure <alias> --host <host> --user <user> [options]
  mysql-ops configure <alias> --socket <path> --user <user> [options]
  mysql-ops list
  mysql-ops show <alias>
  mysql-ops remove <alias> --yes
  mysql-ops ping <alias> [connection options]
  mysql-ops databases <alias> [connection options]
  mysql-ops tables <alias> [--database <db>] [connection options]
  mysql-ops describe <alias> [--database <db>] --table <table> [connection options]
  mysql-ops query <alias> [--database <db>] (--sql <statement> | --stdin) [connection options]
  mysql-ops execute <alias> [--database <db>] (--sql <statement> | --stdin) --allow-write [--allow-destructive]
  mysql-ops run-file <alias> [--database <db>] --file <path> --allow-write --allow-destructive
  mysql-ops dump <alias> [--database <db>] --output <path> [--overwrite]
  mysql-ops paths

Configure options:
  --port <port>                 Default: 3306 for TCP
  --database <db>               Save a default database
  --ssl-mode <mode>             DISABLED, PREFERRED, REQUIRED, VERIFY_CA, VERIFY_IDENTITY
  --ssl-ca <path>               CA certificate path; implies VERIFY_IDENTITY when mode is omitted
  --protocol <type>             TCP, SOCKET, PIPE, or MEMORY
  --connect-timeout <seconds>   Default: 10
  --description <text>
  --no-password                 Do not request a password prompt

Connection options may override saved non-secret metadata:
  --database <db>
  --ssl-mode <mode>
  --ssl-ca <path>
  --protocol <type>
  --connect-timeout <seconds>
  --timeout <seconds>           Whole operation timeout; 0 disables it

Output options:
  --json                        Print a machine-readable JSON envelope

Passwords are never accepted as flags or environment variables. Configure aliases in an
interactive terminal; mysql_config_editor prompts without echoing the password.`;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      out._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }

    const raw = token.slice(2);
    const equals = raw.indexOf('=');
    let key;
    let value;
    if (equals >= 0) {
      key = raw.slice(0, equals);
      value = raw.slice(equals + 1);
    } else {
      key = raw;
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        value = next;
        index += 1;
      } else {
        value = true;
      }
    }
    out[toCamel(key)] = value;
  }
  return out;
}

function toCamel(value) {
  return value.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function truthy(value) {
  return value === true || value === 'true' || value === '1';
}

function wantsJson(opts = {}) {
  return truthy(opts.json);
}

function argvWantsJson(argv) {
  const separator = argv.indexOf('--');
  const options = separator >= 0 ? argv.slice(0, separator) : argv;
  return options.some((value) => value === '--json' || /^--json=(?:true|1)?$/u.test(value));
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeLine(value) {
  const text = String(value);
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function validateAlias(alias) {
  if (!alias || !/^[A-Za-z0-9._-]{1,64}$/u.test(alias)) {
    throw new Error('Alias must be 1-64 ASCII letters, digits, dots, underscores, or dashes');
  }
  return alias;
}

function validateDatabase(value, required = false) {
  if ((value === undefined || value === '') && !required) return '';
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.includes('\0')) {
    throw new Error('Database name must be 1-256 characters and contain no NUL byte');
  }
  return value;
}

function validateTable(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || value.includes('\0')) {
    throw new Error('Table name must be 1-256 characters and contain no NUL byte');
  }
  return value;
}

function asPort(value, fallback = 3306) {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }
  return port;
}

function asNonNegativeSeconds(value, fallback) {
  const seconds = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new Error(`Invalid timeout seconds: ${value}`);
  }
  return seconds;
}

function normalizeSslMode(value) {
  if (!value) return '';
  const mode = String(value).toUpperCase();
  if (!SSL_MODES.has(mode)) {
    throw new Error(`Invalid SSL mode: ${value}`);
  }
  return mode;
}

function normalizeProtocol(value) {
  if (!value) return '';
  const protocol = String(value).toUpperCase();
  if (!PROTOCOLS.has(protocol)) {
    throw new Error(`Invalid protocol: ${value}`);
  }
  return protocol;
}

function expandHome(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function absolutePath(value) {
  if (!value || value === true) throw new Error('A file path value is required');
  return path.resolve(expandHome(String(value)));
}

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(DATA_DIR, 0o700);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return { version: 1, connections: {} };
  const value = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (value?.version !== 1 || !value.connections || typeof value.connections !== 'object') {
    throw new Error(`Unsupported or invalid mysql-ops config: ${CONFIG_PATH}`);
  }
  return value;
}

function writeConfig(config) {
  ensureStorage();
  const temporary = `${CONFIG_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(temporary, 0o600);
  } catch {
    // Best effort on filesystems without POSIX permissions.
  }
  fs.renameSync(temporary, CONFIG_PATH);
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function resolveTool(program) {
  if (path.isAbsolute(program) || process.platform === 'win32') return program;
  const pathDirectories = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const directory of [...new Set([...pathDirectories, ...HOMEBREW_MYSQL_CLIENT_DIRS])]) {
    const candidate = path.join(directory, program);
    if (isExecutable(candidate)) return candidate;
  }
  return program;
}

function toolVersion(program) {
  const result = spawnSync(resolveTool(program), ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') return { installed: false, version: '' };
  if (result.error) return { installed: false, version: result.error.message };
  const version = `${result.stdout || ''}${result.stderr || ''}`.trim();
  return { installed: result.status === 0, version };
}

function requireTool(program) {
  const result = toolVersion(program);
  if (!result.installed) {
    throw new Error(`Required MySQL client program not found: ${program}. Run mysql-ops doctor.`);
  }
  return resolveTool(program);
}

function runCaptured(program, args, options = {}) {
  const spawnOptions = {
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  };
  if (options.input !== undefined) spawnOptions.input = options.input;
  if (options.stdio !== undefined) spawnOptions.stdio = options.stdio;
  if (options.timeoutMs) spawnOptions.timeout = options.timeoutMs;

  const result = spawnSync(resolveTool(program), args, spawnOptions);
  if (result.error?.code === 'ENOENT') {
    throw new Error(`Required MySQL client program not found: ${program}. Run mysql-ops doctor.`);
  }
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`${program} timed out`);
  }
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    signal: result.signal || '',
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function checked(result, label) {
  if (result.exitCode === 0) return result;
  const detail = (result.stderr || result.stdout).trim().slice(-4000);
  const error = new Error(`${label} failed with exit code ${result.exitCode}${detail ? `: ${detail}` : ''}`);
  error.exitCode = result.exitCode;
  throw error;
}

function printOperation(opts, payload) {
  if (wantsJson(opts)) {
    printJson(payload);
    return;
  }
  if (payload.stdout) process.stdout.write(payload.stdout);
  if (payload.stderr) process.stderr.write(payload.stderr);
  if (!payload.stdout && !payload.stderr) writeLine('OK');
}

function doctorCommand(opts) {
  const tools = ['mysql', 'mysqldump', 'mysql_config_editor'].map((name) => ({
    name,
    ...toolVersion(name),
  }));
  const success = tools.every((tool) => tool.installed);
  const payload = { success, tools };
  if (wantsJson(opts)) {
    printJson(payload);
  } else {
    writeLine(tools.map((tool) => (
      `${tool.installed ? 'OK' : 'MISSING'}  ${tool.name}${tool.version ? `  ${tool.version}` : ''}`
    )).join('\n'));
    if (!success) writeLine('Install the official MySQL client tools, then run doctor again.');
  }
  if (!success) process.exitCode = 1;
}

function rejectSecretFlags(opts) {
  for (const key of ['password', 'passwd', 'secret', 'passwordFile', 'uri', 'url']) {
    if (Object.prototype.hasOwnProperty.call(opts, key)) {
      throw new Error(`Do not pass ${key} as a flag; use the mysql_config_editor terminal prompt`);
    }
  }
  if (process.env.MYSQL_PWD) {
    throw new Error('MYSQL_PWD is set. Unset it and use a mysql_config_editor login path instead.');
  }
}

function rejectRawConnectionOverrides(opts) {
  for (const key of ['host', 'user', 'port', 'socket']) {
    if (Object.prototype.hasOwnProperty.call(opts, key)) {
      throw new Error(`Raw --${key} overrides are not allowed; configure and use a named alias`);
    }
  }
}

function configureCommand(alias, opts) {
  validateAlias(alias);
  rejectSecretFlags(opts);
  const configEditor = requireTool('mysql_config_editor');
  if (!process.stdin.isTTY) {
    throw new Error('configure requires an interactive terminal so prompts stay outside chat');
  }

  const host = opts.host ? String(opts.host) : '';
  const socket = opts.socket ? absolutePath(opts.socket) : '';
  const user = opts.user ? String(opts.user) : '';
  if ((!host && !socket) || (host && socket)) {
    throw new Error('Specify exactly one of --host or --socket');
  }
  if (!user) throw new Error('--user is required');
  if (host.includes('\0') || user.includes('\0')) throw new Error('Host and user must contain no NUL byte');
  if (socket && opts.port !== undefined) throw new Error('--port cannot be used with --socket');

  const port = host ? asPort(opts.port, 3306) : undefined;
  const database = validateDatabase(opts.database, false);
  const sslCa = opts.sslCa ? absolutePath(opts.sslCa) : '';
  if (sslCa && !fs.existsSync(sslCa)) throw new Error(`SSL CA file not found: ${sslCa}`);
  const sslMode = normalizeSslMode(opts.sslMode) || (sslCa ? 'VERIFY_IDENTITY' : '');
  if (sslMode === 'DISABLED' && sslCa) throw new Error('--ssl-ca cannot be used with --ssl-mode DISABLED');
  const protocol = normalizeProtocol(opts.protocol) || (host ? 'TCP' : 'SOCKET');
  const connectTimeout = asNonNegativeSeconds(opts.connectTimeout, 10);

  const editorArgs = ['set', `--login-path=${alias}`, `--user=${user}`];
  if (host) editorArgs.push(`--host=${host}`, `--port=${port}`);
  if (socket) editorArgs.push(`--socket=${socket}`);
  if (!truthy(opts.noPassword)) editorArgs.push('--password');

  const result = spawnSync(configEditor, editorArgs, {
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error?.code === 'ENOENT') throw new Error('mysql_config_editor not found');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`mysql_config_editor failed with exit code ${result.status ?? 1}`);
    error.exitCode = result.status ?? 1;
    throw error;
  }

  const config = readConfig();
  const existing = config.connections[alias];
  const now = new Date().toISOString();
  config.connections[alias] = {
    alias,
    database,
    sslMode,
    sslCa,
    protocol,
    connectTimeout,
    description: opts.description ? String(opts.description) : '',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  writeConfig(config);

  const payload = { success: true, alias, database, sslMode, protocol, passwordPrompted: !truthy(opts.noPassword) };
  if (wantsJson(opts)) printJson(payload);
  else writeLine(`Configured ${alias} protocol=${protocol} tls=${sslMode || 'client-default'} database=${database || '(none)'}`);
}

function parseLoginPaths(text) {
  const paths = {};
  let current = null;
  for (const rawLine of String(text).split(/\r?\n/u)) {
    const line = rawLine.trim();
    const header = line.match(/^\[([^\]]+)\]$/u);
    if (header) {
      current = { alias: header[1], passwordConfigured: false };
      paths[current.alias] = current;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === 'password') current.passwordConfigured = true;
    else current[key] = value;
  }
  return paths;
}

function loadLoginPaths() {
  requireTool('mysql_config_editor');
  const result = checked(
    runCaptured('mysql_config_editor', ['print', '--all']),
    'mysql_config_editor print',
  );
  return parseLoginPaths(result.stdout);
}

function sanitizedConnection(alias, loginPath, metadata) {
  return {
    alias,
    loginPathPresent: Boolean(loginPath),
    user: loginPath?.user || '',
    host: loginPath?.host || '',
    port: loginPath?.port ? Number(loginPath.port) : null,
    socket: loginPath?.socket || '',
    passwordConfigured: Boolean(loginPath?.passwordConfigured),
    database: metadata?.database || '',
    sslMode: metadata?.sslMode || '',
    sslCa: metadata?.sslCa || '',
    protocol: metadata?.protocol || '',
    connectTimeout: metadata?.connectTimeout ?? 10,
    description: metadata?.description || '',
    createdAt: metadata?.createdAt || '',
    updatedAt: metadata?.updatedAt || '',
  };
}

function allConnections() {
  const loginPaths = loadLoginPaths();
  const metadata = readConfig().connections;
  const aliases = [...new Set([...Object.keys(loginPaths), ...Object.keys(metadata)])].sort();
  return aliases.map((alias) => sanitizedConnection(alias, loginPaths[alias], metadata[alias]));
}

function formatConnectionLine(connection) {
  const target = connection.socket
    ? `socket=${connection.socket}`
    : `${connection.user || '?'}@${connection.host || '?'}:${connection.port || 3306}`;
  const parts = [connection.alias, target];
  if (!connection.loginPathPresent) parts.push('login-path=MISSING');
  if (connection.database) parts.push(`db=${connection.database}`);
  if (connection.sslMode) parts.push(`tls=${connection.sslMode}`);
  if (connection.description) parts.push(connection.description);
  return parts.join('  ');
}

function listCommand(opts) {
  const connections = allConnections();
  const payload = { success: true, count: connections.length, connections };
  if (wantsJson(opts)) printJson(payload);
  else if (connections.length === 0) writeLine('No MySQL aliases configured.');
  else writeLine([`${connections.length} connection(s):`, ...connections.map((item) => `- ${formatConnectionLine(item)}`)].join('\n'));
}

function showCommand(alias, opts) {
  validateAlias(alias);
  const connection = allConnections().find((item) => item.alias === alias);
  if (!connection) throw new Error(`Alias not found: ${alias}`);
  const payload = { success: true, connection };
  if (wantsJson(opts)) {
    printJson(payload);
    return;
  }
  writeLine([
    connection.alias,
    `  loginPathPresent: ${connection.loginPathPresent ? 'yes' : 'no'}`,
    `  user: ${connection.user || '(not shown)'}`,
    `  host: ${connection.host || '(none)'}`,
    `  port: ${connection.port || '(default)'}`,
    `  socket: ${connection.socket || '(none)'}`,
    `  passwordConfigured: ${connection.passwordConfigured ? 'yes' : 'no'}`,
    `  database: ${connection.database || '(none)'}`,
    `  protocol: ${connection.protocol || '(client default)'}`,
    `  sslMode: ${connection.sslMode || '(client default)'}`,
    `  sslCa: ${connection.sslCa || '(none)'}`,
    `  connectTimeout: ${connection.connectTimeout}s`,
    `  description: ${connection.description || '(none)'}`,
  ].join('\n'));
}

function removeCommand(alias, opts) {
  validateAlias(alias);
  if (!truthy(opts.yes)) throw new Error('remove requires --yes after explicit user approval');
  requireTool('mysql_config_editor');
  checked(
    runCaptured('mysql_config_editor', ['remove', `--login-path=${alias}`, '--skip-warn']),
    `remove alias ${alias}`,
  );
  const config = readConfig();
  const metadataRemoved = Boolean(config.connections[alias]);
  delete config.connections[alias];
  writeConfig(config);
  const payload = { success: true, alias, metadataRemoved };
  if (wantsJson(opts)) printJson(payload);
  else writeLine(`Removed MySQL alias: ${alias}`);
}

function connectionMetadata(alias) {
  return readConfig().connections[alias] || {};
}

function buildConnection(alias, opts, requireDatabase = false) {
  validateAlias(alias);
  rejectSecretFlags(opts);
  rejectRawConnectionOverrides(opts);
  const metadata = connectionMetadata(alias);
  const database = validateDatabase(opts.database ?? metadata.database, requireDatabase);
  const sslCa = opts.sslCa ? absolutePath(opts.sslCa) : (metadata.sslCa || '');
  if (sslCa && !fs.existsSync(sslCa)) throw new Error(`SSL CA file not found: ${sslCa}`);
  const sslMode = normalizeSslMode(opts.sslMode ?? metadata.sslMode) || (sslCa ? 'VERIFY_IDENTITY' : '');
  if (sslMode === 'DISABLED' && sslCa) throw new Error('--ssl-ca cannot be used with --ssl-mode DISABLED');
  const protocol = normalizeProtocol(opts.protocol ?? metadata.protocol);
  const connectTimeout = asNonNegativeSeconds(opts.connectTimeout, metadata.connectTimeout ?? 10);

  const args = [`--login-path=${alias}`];
  if (protocol) args.push(`--protocol=${protocol}`);
  args.push(`--connect-timeout=${connectTimeout}`);
  if (sslMode) args.push(`--ssl-mode=${sslMode}`);
  if (sslCa) args.push(`--ssl-ca=${sslCa}`);
  return { alias, database, sslMode, sslCa, protocol, connectTimeout, args };
}

function operationTimeoutMs(opts, fallbackSeconds) {
  const seconds = asNonNegativeSeconds(opts.timeout, fallbackSeconds);
  return seconds === 0 ? undefined : Math.ceil(seconds * 1000);
}

function quoteIdentifier(value) {
  return `\`${String(value).replace(/`/gu, '``')}\``;
}

function sqlInput(opts) {
  const hasSql = opts.sql !== undefined;
  const hasStdin = truthy(opts.stdin);
  if (hasSql === hasStdin) throw new Error('Specify exactly one of --sql or --stdin');
  if (hasSql) {
    if (opts.sql === true) throw new Error('--sql requires a statement value; prefer --stdin for complex SQL');
    return String(opts.sql);
  }
  return fs.readFileSync(0, 'utf8');
}

const CLIENT_SHELL_COMMAND = /^\s*(?:\\!|system(?:\s|$)|source(?:\s|$)|\\\.(?:\s|$)|tee(?:\s|$)|pager(?:\s|$)|edit(?:\s|$)|connect(?:\s|$)|quit(?:\s|$)|exit(?:\s|$))/iu;

function assertNoClientShellCommands(sql) {
  for (const line of String(sql).split(/\r?\n/u)) {
    if (CLIENT_SHELL_COMMAND.test(line)) throw new Error('MySQL client shell/file commands are not allowed');
  }
}

function assertNoClientShellCommandsInFile(file) {
  const descriptor = fs.openSync(file, 'r');
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = '';
  try {
    while (true) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const text = carry + decoder.write(buffer.subarray(0, bytesRead));
      const lines = text.split(/\r?\n/u);
      carry = lines.pop() || '';
      for (const line of lines) {
        if (CLIENT_SHELL_COMMAND.test(line)) {
          throw new Error('SQL file contains a forbidden MySQL client shell/file command');
        }
      }
    }
    carry += decoder.end();
    if (CLIENT_SHELL_COMMAND.test(carry)) {
      throw new Error('SQL file contains a forbidden MySQL client shell/file command');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function maskSql(sql) {
  let output = '';
  let state = 'normal';
  let quote = '';

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1] || '';

    if (state === 'line-comment') {
      if (char === '\n') {
        state = 'normal';
        output += '\n';
      } else output += ' ';
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'normal';
      } else output += char === '\n' ? '\n' : ' ';
      continue;
    }

    if (state === 'quoted') {
      if (char === '\\' && quote !== '`') {
        output += ' ';
        if (next) {
          output += next === '\n' ? '\n' : ' ';
          index += 1;
        }
        continue;
      }
      if (char === quote) {
        if (next === quote) {
          output += '  ';
          index += 1;
        } else {
          output += ' ';
          state = 'normal';
        }
      } else output += char === '\n' ? '\n' : ' ';
      continue;
    }

    if (char === '#') {
      output += ' ';
      state = 'line-comment';
      continue;
    }
    if (char === '-' && next === '-' && /\s/u.test(sql[index + 2] || '')) {
      output += '  ';
      index += 1;
      state = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      state = 'quoted';
      output += ' ';
      continue;
    }
    output += char;
  }
  return output;
}

function assertReadOnlySql(sql) {
  assertNoClientShellCommands(sql);
  if (/\/\*!/u.test(sql)) {
    throw new Error('Versioned executable comments are not allowed in read-only query mode');
  }
  const masked = maskSql(sql).trim();
  const withoutTrailingTerminator = masked.replace(/;+\s*$/u, '').trim();
  if (!withoutTrailingTerminator) throw new Error('SQL statement is empty');
  if (withoutTrailingTerminator.includes(';')) {
    throw new Error('query accepts exactly one SQL statement');
  }

  const first = withoutTrailingTerminator.match(/^([A-Za-z]+)/u)?.[1]?.toUpperCase();
  if (!['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN'].includes(first)) {
    throw new Error(`query only permits SELECT, SHOW, DESCRIBE, DESC, or EXPLAIN; found ${first || 'unknown'}`);
  }

  const upper = withoutTrailingTerminator.toUpperCase();
  const forbidden = [
    /\bINTO\s+(?:OUTFILE|DUMPFILE)\b/u,
    /\bFOR\s+UPDATE\b/u,
    /\bLOCK\s+IN\s+SHARE\s+MODE\b/u,
    /\b(?:GET_LOCK|RELEASE_LOCK|SLEEP|BENCHMARK)\s*\(/u,
  ];
  if (forbidden.some((pattern) => pattern.test(upper))) {
    throw new Error('query contains a locking, server-file, or resource-intensive side effect');
  }
  if (first === 'EXPLAIN' && /^EXPLAIN\s+ANALYZE\b/u.test(upper)) {
    throw new Error('EXPLAIN ANALYZE executes the statement and is not allowed in read-only query mode');
  }
}

function containsDestructiveSql(sql) {
  if (/\/\*!/u.test(sql)) return true;
  const upper = maskSql(sql).toUpperCase();
  return /\b(?:DROP|TRUNCATE|SHUTDOWN|GRANT|REVOKE)\b|\bCREATE\s+USER\b|\bALTER\s+USER\b|\bSET\s+GLOBAL\b|\bRESET\s+(?:MASTER|BINARY\s+LOGS)\b|\bPURGE\s+BINARY\s+LOGS\b/u.test(upper);
}

function runMysqlSql(alias, opts, sql, operation, fallbackTimeoutSeconds) {
  requireTool('mysql');
  const connection = buildConnection(alias, opts, false);
  const args = [
    ...connection.args,
    '--default-character-set=utf8mb4',
    '--show-warnings',
    wantsJson(opts) ? '--batch' : '--table',
  ];
  if (connection.database) args.push(`--database=${connection.database}`);
  const result = checked(
    runCaptured('mysql', args, {
      input: sql,
      timeoutMs: operationTimeoutMs(opts, fallbackTimeoutSeconds),
    }),
    `${operation} on ${alias}${connection.database ? `/${connection.database}` : ''}`,
  );
  printOperation(opts, {
    success: true,
    operation,
    alias,
    database: connection.database,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function pingCommand(alias, opts) {
  const sql = 'SELECT 1 AS ok, VERSION() AS server_version, CURRENT_USER() AS authenticated_as, DATABASE() AS current_database;\n';
  runMysqlSql(alias, opts, sql, 'ping', 20);
}

function databasesCommand(alias, opts) {
  runMysqlSql(alias, opts, 'SHOW DATABASES;\n', 'databases', 30);
}

function tablesCommand(alias, opts) {
  const connection = buildConnection(alias, opts, true);
  runMysqlSql(alias, { ...opts, database: connection.database }, 'SHOW FULL TABLES;\n', 'tables', 30);
}

function describeCommand(alias, opts) {
  const table = validateTable(opts.table);
  const connection = buildConnection(alias, opts, true);
  const quoted = quoteIdentifier(table);
  const sql = `SHOW FULL COLUMNS FROM ${quoted};\nSHOW INDEX FROM ${quoted};\n`;
  runMysqlSql(alias, { ...opts, database: connection.database }, sql, 'describe', 30);
}

function queryCommand(alias, opts) {
  const sql = sqlInput(opts);
  assertReadOnlySql(sql);
  runMysqlSql(alias, opts, sql, 'query', 30);
}

function executeCommand(alias, opts) {
  if (!truthy(opts.allowWrite)) throw new Error('execute requires --allow-write after explicit user approval');
  const sql = sqlInput(opts);
  assertNoClientShellCommands(sql);
  if (containsDestructiveSql(sql) && !truthy(opts.allowDestructive)) {
    throw new Error('Destructive SQL requires --allow-destructive after explicit user approval');
  }
  runMysqlSql(alias, opts, sql, 'execute', 60);
}

function runFileCommand(alias, opts) {
  if (!truthy(opts.allowWrite) || !truthy(opts.allowDestructive)) {
    throw new Error('run-file requires --allow-write and --allow-destructive after explicit user approval');
  }
  requireTool('mysql');
  const file = absolutePath(opts.file);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error(`SQL input is not a regular file: ${file}`);
  assertNoClientShellCommandsInFile(file);
  const connection = buildConnection(alias, opts, true);
  const args = [
    ...connection.args,
    '--default-character-set=utf8mb4',
    '--show-warnings',
    `--database=${connection.database}`,
  ];
  const descriptor = fs.openSync(file, 'r');
  let result;
  try {
    result = runCaptured('mysql', args, {
      stdio: [descriptor, 'pipe', 'pipe'],
      timeoutMs: operationTimeoutMs(opts, 0),
    });
  } finally {
    fs.closeSync(descriptor);
  }
  checked(result, `run SQL file on ${alias}/${connection.database}`);
  printOperation(opts, {
    success: true,
    operation: 'run-file',
    alias,
    database: connection.database,
    file,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

function moveDumpIntoPlace(temporary, output, overwrite) {
  try {
    fs.renameSync(temporary, output);
  } catch (error) {
    if (!overwrite || !fs.existsSync(output) || !['EEXIST', 'EPERM'].includes(error.code)) throw error;
    fs.rmSync(output, { force: true });
    fs.renameSync(temporary, output);
  }
}

function dumpCommand(alias, opts) {
  requireTool('mysqldump');
  const connection = buildConnection(alias, opts, true);
  const output = absolutePath(opts.output);
  const parent = path.dirname(output);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    throw new Error(`Output directory does not exist: ${parent}`);
  }
  const overwrite = truthy(opts.overwrite);
  if (fs.existsSync(output)) {
    if (fs.lstatSync(output).isSymbolicLink()) throw new Error(`Refusing to overwrite symbolic link: ${output}`);
    if (!overwrite) throw new Error(`Output already exists; explicit --overwrite approval is required: ${output}`);
  }

  let result;
  let temporaryDirectory = '';
  try {
    temporaryDirectory = fs.mkdtempSync(path.join(parent, '.mysql-ops-'));
    try {
      fs.chmodSync(temporaryDirectory, 0o700);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
    const temporary = path.join(temporaryDirectory, 'dump.sql');
    const args = [
      ...connection.args,
      '--default-character-set=utf8mb4',
      '--single-transaction',
      '--quick',
      '--skip-lock-tables',
      '--routines',
      '--events',
      '--triggers',
      '--set-gtid-purged=OFF',
      '--no-tablespaces',
      `--result-file=${temporary}`,
      '--databases',
      connection.database,
    ];
    result = runCaptured('mysqldump', args, {
      timeoutMs: operationTimeoutMs(opts, 0),
    });
    checked(result, `dump ${alias}/${connection.database}`);
    fs.chmodSync(temporary, 0o600);
    moveDumpIntoPlace(temporary, output, overwrite);
    try {
      fs.chmodSync(output, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  } finally {
    if (temporaryDirectory) fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }

  const payload = {
    success: true,
    operation: 'dump',
    alias,
    database: connection.database,
    output,
    bytes: fs.statSync(output).size,
    exitCode: result.exitCode,
    stderr: result.stderr,
  };
  if (wantsJson(opts)) printJson(payload);
  else {
    writeLine(`Dumped ${alias}/${connection.database} to ${output} (${payload.bytes} bytes)`);
    if (payload.stderr) process.stderr.write(payload.stderr);
  }
}

function pathsCommand(opts) {
  const payload = {
    success: true,
    dataDir: DATA_DIR,
    configPath: CONFIG_PATH,
    credentialProvider: 'mysql_config_editor login paths',
  };
  if (wantsJson(opts)) printJson(payload);
  else writeLine([
    `data: ${DATA_DIR}`,
    `config: ${CONFIG_PATH}`,
    'credentials: mysql_config_editor login paths (never read directly)',
  ].join('\n'));
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const opts = parseArgs(rest);

  if (!command || ['help', '--help', '-h'].includes(command)) {
    writeLine(usage());
    return;
  }
  if (command === 'doctor') return doctorCommand(opts);
  if (command === 'configure') return configureCommand(opts._[0], opts);
  if (command === 'list') return listCommand(opts);
  if (command === 'show') return showCommand(opts._[0], opts);
  if (command === 'remove') return removeCommand(opts._[0], opts);
  if (command === 'ping') return pingCommand(opts._[0], opts);
  if (command === 'databases') return databasesCommand(opts._[0], opts);
  if (command === 'tables') return tablesCommand(opts._[0], opts);
  if (command === 'describe') return describeCommand(opts._[0], opts);
  if (command === 'query') return queryCommand(opts._[0], opts);
  if (command === 'execute') return executeCommand(opts._[0], opts);
  if (command === 'run-file') return runFileCommand(opts._[0], opts);
  if (command === 'dump') return dumpCommand(opts._[0], opts);
  if (command === 'paths') return pathsCommand(opts);
  throw new Error(`Unknown command: ${command}`);
}

try {
  main();
} catch (error) {
  if (argvWantsJson(process.argv.slice(2))) {
    printJson({ success: false, error: error.message });
  } else {
    process.stderr.write(`Error: ${error.message}\n`);
  }
  process.exitCode = error.exitCode || 1;
}
