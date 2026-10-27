#!/usr/bin/env node
// Monish CLI: one-command setup for Claude Code, Codex and Cursor, and a ping from the shell.
// No dependencies, Node 18 or later. Contract: https://monish.cc/skill
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const VERSION = require('../package.json').version;
const SKILL_URL = 'https://monish.cc/skill';
const SEND_URL = 'https://monish.cc/v1/send';
const KEY_RE = /^an_[1-9A-HJ-NP-Za-km-z]{10}$/;
const HOOK_MATCHER = 'permission_prompt|elicitation_dialog';
const HOOK_COMMAND = '~/.config/monish/hook.sh';
const RULE =
  'When a task longer than a minute finishes, fails, or needs my decision, call the Monish endpoint as described in https://monish.cc/skill with the key in ~/.config/monish/key. One item per task, same id for progress then done.';

const HOME = os.homedir();
const P = {
  configDir: path.join(HOME, '.config', 'monish'),
  keyFile: path.join(HOME, '.config', 'monish', 'key'),
  hookFile: path.join(HOME, '.config', 'monish', 'hook.sh'),
  claudeDir: path.join(HOME, '.claude'),
  settings: path.join(HOME, '.claude', 'settings.json'),
  skillFile: path.join(HOME, '.claude', 'skills', 'monish', 'SKILL.md'),
  codexDir: path.join(HOME, '.codex'),
  codexAgents: path.join(HOME, '.codex', 'AGENTS.md'),
  cursorDir: path.join(HOME, '.cursor'),
};
const BUNDLED_SKILL = path.join(__dirname, '..', 'skills', 'monish', 'SKILL.md');
const BUNDLED_HOOK = path.join(__dirname, '..', 'hooks', 'notify.sh');
const INTERACTIVE = Boolean(process.stdin.isTTY && process.stdout.isTTY);

// ---------------------------------------------------------------- small helpers

const say = (msg = '') => process.stdout.write(`${msg}\n`);
const step = (msg) => say(`  ${msg}`);
const tilde = (p) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
const exists = (p) => {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fail(msg, code = 1) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}

function onPath(cmd) {
  return (process.env.PATH || '').split(path.delimiter).some((dir) => dir && exists(path.join(dir, cmd)));
}

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeAtomic(p, text, mode) {
  const tmp = `${p}.monish-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, p);
}

let rl = null;
function ask(question) {
  if (!rl) rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

// Returns true or false when it could ask (or --yes), null when it could not (no terminal).
async function confirm(question, flags) {
  if (flags.yes) return true;
  if (!INTERACTIVE) return null;
  const a = (await ask(`  ${question} [Y/n] `)).toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}

function parseArgs(argv) {
  const flags = {};
  const args = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const [name, inline] = a.startsWith('--') ? a.slice(2).split(/=(.*)/s, 2) : [null, null];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (a === '-h' || name === 'help') flags.help = true;
    else if (a === '-v' || name === 'version') flags.version = true;
    else if (a === '-y' || name === 'yes') flags.yes = true;
    else if (name === 'key') flags.key = value();
    else if (name === 'agent') flags.agent = value();
    else if (name === 'body') flags.body = value();
    else if (name === 'type') flags.type = value();
    else if (name === 'no-skill') flags.skill = false;
    else if (name === 'no-hook') flags.hook = false;
    else if (name === 'codex') flags.codex = true;
    else if (name === 'no-codex') flags.codex = false;
    else if (name === 'cursor') flags.cursor = true;
    else if (name === 'no-cursor') flags.cursor = false;
    else if (a.startsWith('-')) fail(`Unknown option ${a}. Run \`npx monish --help\`.`);
    else args.push(a);
  }
  return { flags, args };
}

const project = () => path.basename(process.cwd()) || 'shell';
const label = (flags, tool) => (flags.agent || `${tool} · ${project()}`).slice(0, 40);

// ---------------------------------------------------------------- key

function extractKey(raw) {
  const m = String(raw).match(/an_[A-Za-z0-9]+/);
  return m ? m[0] : String(raw).trim();
}

function savedKey() {
  const env = process.env.MONISH_KEY && extractKey(process.env.MONISH_KEY);
  if (env) return env;
  const file = readText(P.keyFile);
  return file ? extractKey(file) : null;
}

async function resolveKey(flags) {
  let raw = flags.key || process.env.MONISH_KEY || null;
  if (!raw) {
    const file = readText(P.keyFile);
    if (file && KEY_RE.test(extractKey(file))) {
      const reuse = await confirm(`Use the key already saved in ${tilde(P.keyFile)}?`, flags);
      if (reuse !== false) raw = file;
    }
  }
  if (!raw && INTERACTIVE) raw = await ask('  Paste the key shown in the Monish app (an_…): ');
  if (!raw) {
    fail('No key. Run `npx monish setup --key an_XXXXXXXXXX` with the key shown in the Monish app.');
  }
  const key = extractKey(raw);
  if (!KEY_RE.test(key)) {
    fail(
      'That does not look like a Monish key: it is "an_" followed by 10 letters and digits.\n' +
        'Copy it again from the Monish app, then run `npx monish setup` again.',
    );
  }
  return key;
}

function saveKey(key) {
  fs.mkdirSync(P.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(P.keyFile, key, { mode: 0o600 });
  fs.chmodSync(P.keyFile, 0o600);
  step(`Key saved in ${tilde(P.keyFile)} (only you can read it)`);
}

// ---------------------------------------------------------------- Claude Code

function readSettings() {
  const raw = readText(P.settings);
  if (raw === null || raw.trim() === '') return { raw, settings: {} };
  try {
    const settings = JSON.parse(raw);
    return isObject(settings) ? { raw, settings } : { raw, error: 'it is not a JSON object' };
  } catch (e) {
    return { raw, error: 'it is not valid JSON' };
  }
}

function pluginEnabled() {
  const { settings } = readSettings();
  const enabled = settings && isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  return Object.keys(enabled).some((id) => /^monish@/.test(id) && enabled[id]);
}

async function installSkill() {
  let text = null;
  let from = SKILL_URL;
  try {
    const res = await fetch(SKILL_URL, { signal: AbortSignal.timeout(8000) });
    const body = res.ok ? await res.text() : '';
    if (/^---\s*\nname: monish\n/.test(body)) text = body;
  } catch {
    // offline: fall back to the copy shipped with this package
  }
  if (!text) {
    text = fs.readFileSync(BUNDLED_SKILL, 'utf8');
    from = 'the copy in this package';
  }
  fs.mkdirSync(path.dirname(P.skillFile), { recursive: true });
  fs.writeFileSync(P.skillFile, text);
  step(`Skill installed in ${tilde(P.skillFile)} (from ${from})`);
}

function hookSnippet() {
  return JSON.stringify(
    { hooks: { Notification: [{ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] }] } },
    null,
    2,
  );
}

function installHook() {
  fs.mkdirSync(P.configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(P.hookFile, fs.readFileSync(BUNDLED_HOOK, 'utf8'), { mode: 0o755 });
  fs.chmodSync(P.hookFile, 0o755);

  const { raw, settings, error } = readSettings();
  const manual = (why) => {
    step(`Hook script written to ${tilde(P.hookFile)}, but ${tilde(P.settings)} was left untouched because ${why}.`);
    step('Add this to it by hand (merge with your existing "hooks"):');
    say(hookSnippet().replace(/^/gm, '    '));
  };
  if (error) return manual(error);
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return manual('its "hooks" is not an object');
  const hooks = settings.hooks || {};
  const list = hooks.Notification === undefined ? [] : hooks.Notification;
  if (!Array.isArray(list)) return manual('its "hooks.Notification" is not a list');

  const present = list.some(
    (group) =>
      isObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some((h) => isObject(h) && typeof h.command === 'string' && h.command.includes('.config/monish/hook.sh')),
  );
  if (present) {
    step(`Hook already in ${tilde(P.settings)}; script refreshed in ${tilde(P.hookFile)}`);
    return;
  }

  list.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND, timeout: 10 }] });
  hooks.Notification = list;
  settings.hooks = hooks;

  fs.mkdirSync(P.claudeDir, { recursive: true });
  let mode = 0o644;
  if (raw !== null) {
    mode = fs.statSync(P.settings).mode & 0o777;
    fs.writeFileSync(`${P.settings}.monish-backup`, raw, { mode });
  }
  writeAtomic(P.settings, `${JSON.stringify(settings, null, 2)}\n`, mode);
  step(
    `Hook added to ${tilde(P.settings)}: your phone rings when Claude Code waits for your permission` +
      (raw !== null ? ` (previous file kept as settings.json.monish-backup)` : ''),
  );
  if (!onPath('jq')) step('The hook needs jq: it ships with macOS 15 and later, otherwise `brew install jq` or `apt install jq`.');
}

async function setupClaude(flags) {
  if (!exists(P.claudeDir) && !onPath('claude')) {
    step('Claude Code not found: skill and hook skipped');
    return;
  }
  if (pluginEnabled()) {
    step('Monish plugin enabled in Claude Code: it already brings the skill and the hook');
    return;
  }
  if (flags.skill !== false) await installSkill();
  if (flags.hook !== false) installHook();
}

// ---------------------------------------------------------------- Codex and Cursor

async function setupCodex(flags) {
  if (flags.codex === false) return;
  if (!flags.codex && !exists(P.codexDir) && !onPath('codex')) return;
  if ((readText(P.codexAgents) || '').includes('monish.cc/skill')) {
    step(`Codex: rule already in ${tilde(P.codexAgents)}`);
    return;
  }
  const yes = flags.codex || (await confirm(`Codex found. Add the Monish rule to ${tilde(P.codexAgents)} (read in every project)?`, flags));
  if (yes === true) {
    fs.mkdirSync(P.codexDir, { recursive: true });
    const before = readText(P.codexAgents) || '';
    const sep = before === '' ? '' : before.endsWith('\n') ? '\n' : '\n\n';
    fs.appendFileSync(P.codexAgents, `${sep}## Monish\n\n${RULE}\n`);
    step(`Codex: rule added to ${tilde(P.codexAgents)}`);
  } else if (yes === null) {
    step('Codex found: run `npx monish setup --codex` to add the Monish rule to ~/.codex/AGENTS.md');
  } else {
    step('Codex: skipped');
  }
}

async function setupCursor(flags) {
  if (flags.cursor === false) return;
  if (!flags.cursor && !exists(P.cursorDir) && !onPath('cursor')) return;
  const cwd = process.cwd();
  const target = path.join(cwd, '.cursor', 'rules', 'monish.mdc');
  const inProject = cwd !== HOME && (exists(path.join(cwd, '.git')) || exists(path.join(cwd, '.cursor')));
  if (!inProject) {
    step('Cursor: rules live in each project. Run `npx monish setup --cursor` inside a project,');
    step('or paste this line in Cursor Settings > Rules:');
    say(`    ${RULE}`);
    return;
  }
  if (exists(target)) {
    step(`Cursor: rule already in ${path.relative(cwd, target)}`);
    return;
  }
  const yes = flags.cursor || (await confirm(`Cursor found. Add the Monish rule to ${path.relative(cwd, target)} in this project?`, flags));
  if (yes === true) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `---\ndescription: Notify my iPhone through Monish\nalwaysApply: true\n---\n\n${RULE}\n`);
    step(`Cursor: rule added to ${path.relative(cwd, target)}`);
  } else if (yes === null) {
    step('Cursor found: run `npx monish setup --cursor` in a project to add the Monish rule');
  } else {
    step('Cursor: skipped');
  }
}

// ---------------------------------------------------------------- sending

async function send(key, item) {
  try {
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': `monish-cli/${VERSION}` },
      body: JSON.stringify({ key, ...item }),
      signal: AbortSignal.timeout(10000),
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // empty or non-JSON body
    }
    return { status: res.status, data };
  } catch (e) {
    return { status: 0, data: { message: e.cause?.code || e.name || 'network error' } };
  }
}

function explain(status, data) {
  if (status === 202 || status === 200) return null;
  if (status === 401 && data.error === 'unknown_key') {
    return (
      'The Monish app has not registered this key yet (401 unknown_key).\n' +
      'Open Monish on your iPhone, finish the notifications step (allow notifications),\n' +
      'then run `npx monish setup` again. Your key and settings are already saved.'
    );
  }
  if (status === 429) return `Too many sends for this key. Try again in ${data.retry_after || 60} seconds.`;
  if (status === 0) return `Could not reach monish.cc (${data.message}). Check the connection and run the command again.`;
  return `monish.cc answered ${status}${data.error ? ` ${data.error}` : ''}${data.message ? `: ${data.message}` : ''}.`;
}

async function connect(key, flags) {
  const agent = label(flags, 'Claude Code');
  const ping = () =>
    send(key, {
      id: `setup-${Math.floor(Date.now() / 1000)}`,
      type: 'done',
      agent,
      title: 'Connected',
      body: 'Your agent can now reach this iPhone.',
    });
  let { status, data } = await ping();
  if (status === 401 && INTERACTIVE && !flags.yes) {
    say('');
    step('The app has not registered this key yet. Finish the notifications step in Monish,');
    await ask('  then press Enter to send the ping again (Ctrl+C to stop). ');
    ({ status, data } = await ping());
  }
  const problem = explain(status, data);
  if (problem) {
    say('');
    fail(problem);
  }
  step(`Connected: Monish now shows "${agent}" on your iPhone`);
}

// ---------------------------------------------------------------- commands

async function cmdSetup(flags) {
  say('Monish setup');
  const key = await resolveKey(flags);
  saveKey(key);
  await setupClaude(flags);
  await setupCodex(flags);
  await setupCursor(flags);
  await connect(key, flags);
}

async function cmdPing(args, flags) {
  const message = args.join(' ').trim();
  if (!message) fail('Usage: monish ping "message" [--body "detail"] [--type done|failed]');
  const type = flags.type || 'done';
  if (type !== 'done' && type !== 'failed') fail('--type is done or failed.');
  const key = savedKey();
  if (!key) fail('No key found. Run `npx monish setup` first.');
  const item = { id: `ping-${Date.now()}`, type, agent: label(flags, 'Terminal'), title: message };
  if (flags.body) item.body = flags.body;
  const { status, data } = await send(key, item);
  const problem = explain(status, data);
  if (problem) fail(problem);
  say('Sent.');
}

const HELP = `Monish ${VERSION}: your agents on your iPhone lock screen. https://monish.cc

Usage
  npx monish setup [--key an_XXXXXXXXXX]   save the key, install the Claude Code skill and hook,
                                           offer Codex and Cursor, send the "Connected" ping
  npx monish ping "message"                send one line to your iPhone

Setup options
  --key an_…       the key shown in the Monish app (otherwise asked, or read from $MONISH_KEY)
  --agent "label"  name shown on the phone (default: "Claude Code · <folder>")
  --codex          add the Monish rule to ~/.codex/AGENTS.md without asking (--no-codex to skip)
  --cursor         add .cursor/rules/monish.mdc to the current project (--no-cursor to skip)
  --no-skill       do not install ~/.claude/skills/monish/SKILL.md
  --no-hook        do not add the permission prompt hook to ~/.claude/settings.json
  -y, --yes        answer yes to every question

Ping options
  --body "detail"  second line
  --type failed    send it as a failure (default: done)
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, args } = parseArgs(rest);
  if (command === '-v' || command === '--version' || flags.version) return say(VERSION);
  if (!command || command === '-h' || command === '--help' || command === 'help' || flags.help) return say(HELP);
  if (command === 'setup') return cmdSetup(flags);
  if (command === 'ping') return cmdPing(args, flags);
  fail(`Unknown command "${command}".\n\n${HELP}`);
}

main()
  .then(() => rl && rl.close())
  .catch((e) => fail(`monish: ${e.message}`));
