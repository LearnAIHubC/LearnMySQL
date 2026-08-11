import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'skills', 'mysql-ops', 'scripts', 'mysql-ops.mjs');
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mysql-ops-test-'));
const fakeBin = path.join(testRoot, 'bin');
const codexRoot = path.join(testRoot, 'codex');
const mysqlCall = path.join(testRoot, 'mysql-call.json');
const dumpCall = path.join(testRoot, 'dump-call.json');
fs.mkdirSync(fakeBin, { recursive: true });

function installStub(name, source) {
  const file = path.join(fakeBin, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`);
  fs.chmodSync(file, 0o755);
}

installStub('mysql', `
import fs from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write('mysql  Ver 8.4.0\\n');
  process.exit(0);
}
const input = fs.readFileSync(0, 'utf8');
fs.writeFileSync(process.env.MYSQL_OPS_TEST_MYSQL_CALL, JSON.stringify({ args: process.argv.slice(2), input }));
process.stdout.write('ok\\tserver_version\\tauthenticated_as\\tcurrent_database\\n1\\t8.4.0\\treader@%\\tapp\\n');
`);

installStub('mysqldump', `
import fs from 'node:fs';
if (process.argv.includes('--version')) {
  process.stdout.write('mysqldump  Ver 8.4.0\\n');
  process.exit(0);
}
const args = process.argv.slice(2);
const resultFile = args.find((arg) => arg.startsWith('--result-file='));
if (!resultFile) process.exit(2);
fs.writeFileSync(resultFile.slice('--result-file='.length), '-- MySQL dump\\nCREATE TABLE t (id INT);\\n');
fs.writeFileSync(process.env.MYSQL_OPS_TEST_DUMP_CALL, JSON.stringify({ args }));
`);

installStub('mysql_config_editor', `
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('mysql_config_editor  Ver 8.4.0\\n');
  process.exit(0);
}
if (args[0] === 'print') {
  process.stdout.write('[prod]\\nuser = reader\\npassword = *****\\nhost = db.example.com\\nport = 3306\\n[shared]\\nuser = reader\\npassword = *****\\nhost = shared.example.com\\nport = 3306\\n');
  process.exit(0);
}
if (args[0] === 'remove') process.exit(0);
process.exit(3);
`);

const configDir = path.join(codexRoot, 'mysql-ops');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
  version: 1,
  connections: {
    prod: {
      alias: 'prod',
      database: 'app',
      sslMode: 'VERIFY_IDENTITY',
      sslCa: '',
      protocol: 'TCP',
      connectTimeout: 7,
      description: 'production read-only',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    shared: {
      alias: 'shared',
      database: '',
      sslMode: 'REQUIRED',
      sslCa: '',
      protocol: 'TCP',
      connectTimeout: 10,
      description: 'shared server without a default database',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
}));

const baseEnv = {
  ...process.env,
  CODEX_HOME: codexRoot,
  PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}`,
  MYSQL_OPS_TEST_MYSQL_CALL: mysqlCall,
  MYSQL_OPS_TEST_DUMP_CALL: dumpCall,
};
delete baseEnv.MYSQL_PWD;

function run(args, options = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    env: options.env || baseEnv,
    input: options.input,
  });
}

try {
  const doctor = run(['doctor', '--json']);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).success, true);

  const list = run(['list', '--json']);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout.includes('*****'), false);
  const listed = JSON.parse(list.stdout).connections[0];
  assert.equal(listed.alias, 'prod');
  assert.equal(listed.passwordConfigured, true);
  assert.equal(listed.database, 'app');
  assert.equal(listed.sslMode, 'VERIFY_IDENTITY');

  const ping = run(['ping', 'prod', '--json']);
  assert.equal(ping.status, 0, ping.stderr);
  const pingCall = JSON.parse(fs.readFileSync(mysqlCall, 'utf8'));
  assert.equal(pingCall.args[0], '--login-path=prod');
  assert.ok(pingCall.args.includes('--protocol=TCP'));
  assert.ok(pingCall.args.includes('--connect-timeout=7'));
  assert.ok(pingCall.args.includes('--ssl-mode=VERIFY_IDENTITY'));
  assert.equal(pingCall.args.some((arg) => /^--(?:host|user|password)=/u.test(arg)), false);
  assert.match(pingCall.input, /CURRENT_USER/u);

  const noDefaultDatabase = run(['ping', 'shared', '--json']);
  assert.equal(noDefaultDatabase.status, 0, noDefaultDatabase.stderr);
  const noDefaultCall = JSON.parse(fs.readFileSync(mysqlCall, 'utf8'));
  assert.equal(noDefaultCall.args[0], '--login-path=shared');
  assert.equal(noDefaultCall.args.some((arg) => arg.startsWith('--database=')), false);

  const discoverDatabases = run(['databases', 'shared', '--json']);
  assert.equal(discoverDatabases.status, 0, discoverDatabases.stderr);
  const discoverCall = JSON.parse(fs.readFileSync(mysqlCall, 'utf8'));
  assert.equal(discoverCall.args.some((arg) => arg.startsWith('--database=')), false);
  assert.equal(discoverCall.input, 'SHOW DATABASES;\n');

  const rawOverride = run(['ping', 'prod', '--host', 'other.example.com', '--json']);
  assert.equal(rawOverride.status, 1);
  assert.match(JSON.parse(rawOverride.stdout).error, /Raw --host overrides are not allowed/u);

  const quotedSemicolon = run(['query', 'prod', '--sql', "SELECT ';' AS value;", '--json']);
  assert.equal(quotedSemicolon.status, 0, quotedSemicolon.stderr);

  const multiStatement = run(['query', 'prod', '--sql', 'SELECT 1; DELETE FROM users;', '--json']);
  assert.equal(multiStatement.status, 1);
  assert.match(JSON.parse(multiStatement.stdout).error, /exactly one/u);

  const outfile = run(['query', 'prod', '--sql', "SELECT 'x' INTO OUTFILE '/tmp/x';", '--json']);
  assert.equal(outfile.status, 1);
  assert.match(JSON.parse(outfile.stdout).error, /side effect/u);

  const executableComment = run(['query', 'prod', '--sql', 'SELECT 1 /*! INTO OUTFILE \'/tmp/x\' */;', '--json']);
  assert.equal(executableComment.status, 1);
  assert.match(JSON.parse(executableComment.stdout).error, /executable comments/u);

  const deniedWrite = run(['execute', 'prod', '--sql', 'UPDATE users SET active = 1;', '--json']);
  assert.equal(deniedWrite.status, 1);
  assert.match(JSON.parse(deniedWrite.stdout).error, /allow-write/u);

  const deniedDrop = run(['execute', 'prod', '--sql', 'DROP TABLE users;', '--allow-write', '--json']);
  assert.equal(deniedDrop.status, 1);
  assert.match(JSON.parse(deniedDrop.stdout).error, /allow-destructive/u);

  const approvedDrop = run([
    'execute', 'prod', '--sql', 'DROP TABLE users;', '--allow-write', '--allow-destructive', '--json',
  ]);
  assert.equal(approvedDrop.status, 0, approvedDrop.stderr);

  const versionedDrop = run([
    'execute', 'prod', '--sql', 'SELECT 1; /*! DROP TABLE users */;', '--allow-write', '--json',
  ]);
  assert.equal(versionedDrop.status, 1);
  assert.match(JSON.parse(versionedDrop.stdout).error, /allow-destructive/u);

  const sqlFile = path.join(testRoot, 'change.sql');
  fs.writeFileSync(sqlFile, 'UPDATE users SET active = 1 WHERE id = 7;\n');
  const deniedFile = run(['run-file', 'prod', '--file', sqlFile, '--json']);
  assert.equal(deniedFile.status, 1);
  const approvedFile = run([
    'run-file', 'prod', '--file', sqlFile, '--allow-write', '--allow-destructive', '--json',
  ]);
  assert.equal(approvedFile.status, 0, approvedFile.stderr);
  assert.equal(JSON.parse(fs.readFileSync(mysqlCall, 'utf8')).input, fs.readFileSync(sqlFile, 'utf8'));

  const unsafeSqlFile = path.join(testRoot, 'unsafe.sql');
  fs.writeFileSync(unsafeSqlFile, 'SELECT 1;\nsystem touch /tmp/should-not-run\n');
  const unsafeFile = run([
    'run-file', 'prod', '--file', unsafeSqlFile, '--allow-write', '--allow-destructive', '--json',
  ]);
  assert.equal(unsafeFile.status, 1);
  assert.match(JSON.parse(unsafeFile.stdout).error, /forbidden MySQL client/u);

  const dumpFile = path.join(testRoot, 'app.sql');
  const dump = run(['dump', 'prod', '--output', dumpFile, '--json']);
  assert.equal(dump.status, 0, dump.stderr);
  assert.match(fs.readFileSync(dumpFile, 'utf8'), /MySQL dump/u);
  const dumpArgs = JSON.parse(fs.readFileSync(dumpCall, 'utf8')).args;
  assert.equal(dumpArgs[0], '--login-path=prod');
  for (const expected of [
    '--single-transaction', '--quick', '--skip-lock-tables', '--routines', '--events',
    '--triggers', '--set-gtid-purged=OFF', '--no-tablespaces', '--databases', 'app',
  ]) assert.ok(dumpArgs.includes(expected), `missing dump argument ${expected}`);

  fs.writeFileSync(dumpFile, 'keep me\n');
  const noOverwrite = run(['dump', 'prod', '--output', dumpFile, '--json']);
  assert.equal(noOverwrite.status, 1);
  assert.equal(fs.readFileSync(dumpFile, 'utf8'), 'keep me\n');

  const overwrite = run(['dump', 'prod', '--output', dumpFile, '--overwrite', '--json']);
  assert.equal(overwrite.status, 0, overwrite.stderr);
  assert.match(fs.readFileSync(dumpFile, 'utf8'), /MySQL dump/u);

  const secretEnv = { ...baseEnv, MYSQL_PWD: 'must-not-be-used' };
  const rejectedEnv = run(['ping', 'prod', '--json'], { env: secretEnv });
  assert.equal(rejectedEnv.status, 1);
  assert.match(JSON.parse(rejectedEnv.stdout).error, /MYSQL_PWD is set/u);

  const configure = run(['configure', 'new', '--host', 'localhost', '--user', 'reader', '--json']);
  assert.equal(configure.status, 1);
  assert.match(JSON.parse(configure.stdout).error, /interactive terminal/u);

  process.stdout.write('mysql-ops tests passed\n');
} finally {
  fs.rmSync(testRoot, { recursive: true, force: true });
}
