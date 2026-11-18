#!/usr/bin/env node
// Monish CLI: pairs this computer with the Monish iPhone app and installs the Claude Code hooks
// (permissions, questions, plans, forms and turn ends answered from the iPhone, always / session rules
// kept by the Worker, a lock screen card per session), one-command setup for Codex and Cursor, and a
// ping from the shell. No dependencies, Node 18 or later.
// Contract: https://monish.cc/skill
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { spawnSync } = require('child_process');

// Node 18 warns on stderr that fetch is experimental; a hook's stderr can reach Claude.
process.removeAllListeners('warning');

const VERSION = require('../package.json').version;
// Set by install/entry.js in the standalone binary (bun build --compile): no Node, no npx, the hooks
// run that binary and the bundled files come as text.
const STANDALONE = globalThis.MONISH_STANDALONE || null;
const API = 'https://monish.cc';
const SKILL_URL = `${API}/skill`;
const SEND_URL = `${API}/v1/send`;
const KEY_RE = /^an_[1-9A-HJ-NP-Za-km-z]{10}$/;
const HOOK_MATCHER = 'permission_prompt|elicitation_dialog';
const HOOK_COMMAND = '~/.config/monish/hook.sh';
const RULE =
  'When a task longer than a minute finishes, fails, or needs my decision, call the Monish endpoint as described in https://monish.cc/skill with the key in ~/.config/monish/key. One item per task, same id for progress then done.';

const TESTED_CLAUDE = '2.1.325'; // Claude Code version the hooks were proven with
const IDLE_S = 30; // no keystroke for this long in Claude's terminal = away from the keyboard
const GRACE_S = 10; // wait before asking the iPhone when another permission hook may decide first
const MAX_WAIT_S = 3600;
const TOOL_EVENT_S = 15; // at most one `tool` session event per session in this many seconds
const HOOK_TIMEOUT_S = 3660;
const OUR_SCRIPT = '.config/monish/monish.js';

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(HOME, '.claude');
// The hooks run the copy of this file that `pair` puts next to computer.json: that folder is the
// config folder, whatever HOME the hook process sees.
const IS_COPY = fs.existsSync(path.join(__dirname, 'computer.json')) && path.basename(__filename) === 'monish.js';
const CONFIG_DIR = IS_COPY ? __dirname : path.join(HOME, '.config', 'monish');
const P = {
  configDir: CONFIG_DIR,
  keyFile: path.join(CONFIG_DIR, 'key'),
  hookFile: path.join(CONFIG_DIR, 'hook.sh'),
  computer: path.join(CONFIG_DIR, 'computer.json'),
  script: path.join(CONFIG_DIR, 'monish.js'),
  runDir: path.join(CONFIG_DIR, 'run'),
  log: path.join(CONFIG_DIR, 'monish.log'),
  claudeDir: CLAUDE_DIR,
  settings: path.join(CLAUDE_DIR, 'settings.json'),
  skillFile: path.join(CLAUDE_DIR, 'skills', 'monish', 'SKILL.md'),
  plugins: path.join(CLAUDE_DIR, 'plugins', 'installed_plugins.json'),
  codexDir: path.join(HOME, '.codex'),
  codexAgents: path.join(HOME, '.codex', 'AGENTS.md'),
  cursorDir: path.join(HOME, '.cursor'),
};
const BUNDLED_SKILL = path.join(__dirname, '..', 'skills', 'monish', 'SKILL.md');
const BUNDLED_HOOK = path.join(__dirname, '..', 'hooks', 'notify.sh');
const INTERACTIVE = Boolean(process.stdin.isTTY && process.stdout.isTTY);

// ---------------------------------------------------------------- small helpers

const runAs = (msg) =>
  STANDALONE ? String(msg).replace(/^( +)npx monish (.*?\S)( {2,})/gm, '$1monish $2$3    ').replace(/npx monish/g, 'monish') : msg;
const say = (msg = '') => process.stdout.write(`${runAs(msg)}\n`);
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
// A half character (a surrogate left alone by a cut, or sent as such) makes JSON some parsers refuse whole.
const wellFormed = (s) => s.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');
// At most n characters, counted and cut by code point (never half an emoji), … when cut.
const clip = (s, n) => {
  const t = String(s ?? '');
  const points = Array.from(t.length > 2 * n ? t.slice(0, 2 * n + 1) : t);
  return wellFormed(points.length > n ? `${points.slice(0, n - 1).join('')}…` : t);
};
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    if (signal) {
      if (signal.aborted) done();
      else signal.addEventListener('abort', done, { once: true });
    }
  });

function fail(msg, code = 1) {
  process.stderr.write(`${runAs(msg)}\n`);
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

function readJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function writeAtomic(p, text, mode) {
  const tmp = `${p}.monish-tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode });
  fs.chmodSync(tmp, mode);
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
    else if (name === 'name') flags.name = value();
    else if (name === 'api') flags.api = value();
    else if (name === 'all') flags.all = true;
    else if (name === 'replace') flags.replace = true;
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

// ---------------------------------------------------------------- HTTP

let claudeHeader = null; // Claude Code version sent as x-monish-claude

async function http(method, url, { token, body, timeoutMs = 15000, signal } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const headers = { 'user-agent': `monish-cli/${VERSION}` };
  if (claudeHeader) headers['x-monish-claude'] = claudeHeader;
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    let data = {};
    try {
      data = await res.json();
    } catch {
      // empty or non-JSON body
    }
    return { status: res.status, data: isObject(data) ? data : {} };
  } catch (e) {
    return { status: 0, data: { message: e.cause?.code || e.name || 'network error' } };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

const hostOf = (base) => {
  try {
    return new URL(base).host;
  } catch {
    return base;
  }
};

// ---------------------------------------------------------------- key

function extractKey(raw) {
  const m = String(raw).match(/an_[A-Za-z0-9]+/);
  return m ? m[0] : String(raw).trim();
}

const isComputerToken = (text) => /^mc_[1-9A-HJ-NP-Za-km-z]+$/.test(String(text ?? '').trim());

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
  if (!raw && INTERACTIVE) raw = await ask('  Paste the setup line or the key from the Monish app (an_…): ');
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

// ---------------------------------------------------------------- Claude Code settings

function readSettingsAt(file) {
  const raw = readText(file);
  if (raw === null || raw.trim() === '') return { raw, settings: {} };
  try {
    const settings = JSON.parse(raw);
    return isObject(settings) ? { raw, settings } : { raw, error: 'it is not a JSON object' };
  } catch {
    return { raw, error: 'it is not valid JSON' };
  }
}
const readSettings = () => readSettingsAt(P.settings);

// settings.json is often a link into a dotfiles repository: write the file it points to, so the
// link stays a link.
function settingsTarget(file) {
  try {
    return fs.lstatSync(file).isSymbolicLink() ? fs.realpathSync(file) : file;
  } catch {
    return file; // missing file, or a link to nothing
  }
}

function writeSettings(file, raw, settings, backup) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const target = settingsTarget(file);
  let mode = 0o644;
  if (raw !== null) {
    mode = fs.statSync(target).mode & 0o777;
    if (backup) fs.writeFileSync(`${file}.monish-backup`, raw, { mode });
  }
  // Keep the file's own indentation and final newline, so removing our hooks gives back the same file.
  const indent = raw ? (raw.match(/\n([ \t]+)"/) || [])[1] || 2 : 2;
  const eol = raw && raw.trim() !== '' && !raw.endsWith('\n') ? '' : '\n';
  writeAtomic(target, `${JSON.stringify(settings, null, indent)}${eol}`, mode);
  return target;
}

function pluginEnabled() {
  const { settings } = readSettings();
  const enabled = settings && isObject(settings.enabledPlugins) ? settings.enabledPlugins : {};
  return Object.keys(enabled).some((id) => /^monish@/.test(id) && enabled[id]);
}

// The plugin 1.0.x rings "Needs you" on every permission prompt; 1.1.0 stays quiet once paired.
function pluginOutdated() {
  if (!pluginEnabled()) return false;
  const reg = readJSON(P.plugins);
  const entries = isObject(reg) && isObject(reg.plugins) ? Object.entries(reg.plugins) : [];
  const versions = entries
    .filter(([id]) => /^monish@/.test(id))
    .flatMap(([, v]) => (Array.isArray(v) ? v : [v]))
    .map((v) => (isObject(v) ? String(v.version || '') : ''))
    .filter(Boolean);
  const older = (v) => {
    const [a, b] = v.split('.').map(Number);
    return a < 1 || (a === 1 && b < 1);
  };
  return versions.length === 0 || versions.some(older);
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
    text = STANDALONE ? STANDALONE.skill : fs.readFileSync(BUNDLED_SKILL, 'utf8');
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
  fs.writeFileSync(P.hookFile, STANDALONE ? STANDALONE.hook : fs.readFileSync(BUNDLED_HOOK, 'utf8'), { mode: 0o755 });
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

  const target = writeSettings(P.settings, raw, settings, true);
  step(
    `Hook added to ${tilde(P.settings)}${target !== P.settings ? ` (link to ${tilde(target)})` : ''}: ` +
      'your phone rings when Claude Code waits for your permission' +
      (raw !== null ? ' (previous file kept as settings.json.monish-backup)' : ''),
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

// ---------------------------------------------------------------- Claude Code hooks written by `pair`

const HOOKS = [
  { event: 'PermissionRequest', arg: 'permission-request', timeout: HOOK_TIMEOUT_S },
  { event: 'Elicitation', arg: 'elicitation', timeout: HOOK_TIMEOUT_S },
  { event: 'Stop', arg: 'stop', timeout: HOOK_TIMEOUT_S, asyncRewake: true },
  { event: 'StopFailure', arg: 'stop-failure', timeout: 10, async: true },
  { event: 'PostToolUse', arg: 'post-tool-use', timeout: 10, async: true },
  { event: 'UserPromptSubmit', arg: 'user-prompt-submit', timeout: 10, async: true },
  { event: 'PreToolUse', arg: 'pre-tool-use', timeout: 10, async: true },
  { event: 'SessionEnd', arg: 'session-end', timeout: 5, async: true },
];

// Exec form (command + args, no shell): the same entry works on macOS, Linux and Windows.
// Standalone: the installed binary itself; npx: Node and the copy of this file in the config folder.
function hookEntry(h) {
  const args = STANDALONE ? ['hook', h.arg] : [P.script, 'hook', h.arg];
  const e = { type: 'command', command: process.execPath, args, timeout: h.timeout };
  if (h.async) e.async = true;
  if (h.asyncRewake) e.asyncRewake = true;
  return e;
}

const slashes = (s) => String(s).replace(/\\/g, '/');
const isBinaryHook = (h) =>
  isObject(h) && /(^|\/)monish(\.exe)?$/i.test(slashes(h.command || '')) && Array.isArray(h.args) && h.args[0] === 'hook';
function isOurHook(h) {
  if (!isObject(h)) return false;
  if (isBinaryHook(h)) return true;
  const parts = [h.command, ...(Array.isArray(h.args) ? h.args : [])].filter((x) => typeof x === 'string').map(slashes);
  return parts.some((s) => s.includes(OUR_SCRIPT) || s.includes(slashes(P.script)));
}
const isOldHook = (h) => isObject(h) && typeof h.command === 'string' && slashes(h.command).includes('.config/monish/hook.sh');

function hooksShapeError(settings) {
  if (settings.hooks === undefined) return null;
  if (!isObject(settings.hooks)) return 'its "hooks" is not an object';
  for (const ev of [...HOOKS.map((h) => h.event), 'Notification']) {
    if (settings.hooks[ev] !== undefined && !Array.isArray(settings.hooks[ev])) return `its "hooks.${ev}" is not a list`;
  }
  return null;
}

// Removes the entries matching pred; drops the groups and lists that this emptied. Returns the count.
function removeEntries(hooks, pred, events = Object.keys(hooks)) {
  let n = 0;
  for (const ev of events) {
    const list = hooks[ev];
    if (!Array.isArray(list)) continue;
    let touched = false;
    for (let g = 0; g < list.length; g++) {
      const group = list[g];
      if (!isObject(group) || !Array.isArray(group.hooks)) continue;
      const keep = group.hooks.filter((h) => !pred(h));
      if (keep.length === group.hooks.length) continue;
      n += group.hooks.length - keep.length;
      touched = true;
      if (keep.length) group.hooks = keep;
      else list.splice(g--, 1);
    }
    if (touched && list.length === 0) delete hooks[ev];
  }
  return n;
}

// Ours are replaced in place, new ones go at the end of their event's list, nothing else moves.
function addOurHooks(settings) {
  const hooks = isObject(settings.hooks) ? settings.hooks : {};
  removeEntries(hooks, isOldHook, ['Notification']);
  for (const h of HOOKS) {
    const list = Array.isArray(hooks[h.event]) ? hooks[h.event] : [];
    let placed = false;
    for (let g = 0; g < list.length; g++) {
      const group = list[g];
      if (!isObject(group) || !Array.isArray(group.hooks) || !group.hooks.some(isOurHook)) continue;
      group.hooks = group.hooks.flatMap((e) => {
        if (!isOurHook(e)) return [e];
        if (placed) return [];
        placed = true;
        return [hookEntry(h)];
      });
      if (group.hooks.length === 0) list.splice(g--, 1);
    }
    if (!placed) list.push({ hooks: [hookEntry(h)] });
    hooks[h.event] = list;
  }
  settings.hooks = hooks;
}

function removeOurHooks(settings, withOld) {
  if (!isObject(settings.hooks)) return 0;
  const n = removeEntries(settings.hooks, (h) => isOurHook(h) || (withOld && isOldHook(h)));
  if (n && Object.keys(settings.hooks).length === 0) delete settings.hooks;
  return n;
}

function ourHooksSnippet() {
  const hooks = {};
  for (const h of HOOKS) hooks[h.event] = [{ hooks: [hookEntry(h)] }];
  return JSON.stringify({ hooks }, null, 2);
}

function ourEntries(settings) {
  const out = {};
  if (!isObject(settings.hooks)) return out;
  for (const [ev, list] of Object.entries(settings.hooks)) {
    if (!Array.isArray(list)) continue;
    for (const g of list) if (isObject(g) && Array.isArray(g.hooks)) for (const e of g.hooks) if (isOurHook(e)) out[ev] = e;
  }
  return out;
}

// Other PermissionRequest hooks whose matcher covers the tool (user, project and local settings).
// Hooks brought by plugins are not read.
function otherPermissionHooks(userSettings, cwd, tool) {
  const files = [userSettings];
  if (cwd) files.push(path.join(cwd, '.claude', 'settings.json'), path.join(cwd, '.claude', 'settings.local.json'));
  const out = [];
  for (const file of [...new Set(files)]) {
    const { settings } = readSettingsAt(file);
    const list = settings && isObject(settings.hooks) && Array.isArray(settings.hooks.PermissionRequest) ? settings.hooks.PermissionRequest : [];
    for (const g of list) {
      if (!isObject(g) || !Array.isArray(g.hooks)) continue;
      const matcher = typeof g.matcher === 'string' ? g.matcher : '';
      let covers = !matcher || matcher === '*' || !tool;
      if (!covers) {
        try {
          covers = new RegExp(`^(?:${matcher})$`).test(tool);
        } catch {
          covers = matcher === tool;
        }
      }
      if (!covers) continue;
      for (const e of g.hooks) {
        if (!isObject(e) || isOurHook(e)) continue;
        out.push([e.command, ...(Array.isArray(e.args) ? e.args : [])].filter((x) => typeof x === 'string').join(' ') || e.url || e.type || 'hook');
      }
    }
  }
  return out;
}

const otherHookNote = (cmd) =>
  `Another permission hook is installed (${clip(cmd.split(HOME).join("~"), 120)}). ` +
  'Monish waits 10 s before asking your iPhone or applying an always rule, and the first answer wins.';

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

// ---------------------------------------------------------------- sending (setup, ping)

async function send(key, item) {
  return http('POST', SEND_URL, { body: { key, ...item }, timeoutMs: 10000 });
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

// ---------------------------------------------------------------- the paired computer

const DEFAULT_SETTINGS = { answer_window_s: 600, quiet_at_keyboard: true, notify: { permission: true, question: true, turn_end: true } };

function readComputer() {
  const c = readJSON(P.computer);
  return isObject(c) && typeof c.token === 'string' ? c : null;
}

function saveComputer(c) {
  fs.mkdirSync(P.configDir, { recursive: true, mode: 0o700 });
  writeAtomic(P.computer, `${JSON.stringify(c, null, 2)}\n`, 0o600);
}

const apiBase = (c) => String(c.api_base || API).replace(/\/+$/, '');
const notifyOf = (c) => ({ ...DEFAULT_SETTINGS.notify, ...(isObject(c.settings) && isObject(c.settings.notify) ? c.settings.notify : {}) });
const quietOn = (c) => !(isObject(c.settings) && c.settings.quiet_at_keyboard === false);

// Settings changed in the app come back with every request: keep them for the next one.
function refreshSettings(c, settings) {
  if (!isObject(settings) || JSON.stringify(settings) === JSON.stringify(c.settings)) return;
  c.settings = settings;
  try {
    const fresh = readComputer();
    if (fresh && fresh.token === c.token) saveComputer({ ...fresh, settings });
  } catch {
    // read-only disk: the next request brings them again
  }
}

function readClaudeVersion() {
  try {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000, shell: process.platform === 'win32' });
    const m = r.status === 0 && String(r.stdout).match(/\d+\.\d+\.\d+/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

function computerName(given) {
  let n = given;
  if (!n && process.platform === 'darwin') {
    const r = spawnSync('scutil', ['--get', 'ComputerName'], { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0) n = String(r.stdout).trim();
  }
  if (!n) n = os.hostname().replace(/\.local$/i, '');
  n = String(n)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 40);
  return n || 'Computer';
}

const UNPAIRED = 'This computer was unpaired from your iPhone. Run npx monish pair <code> with the code shown in Monish to pair again.';

function installScript() {
  // The copy cannot read ../package.json: it gets the version as a literal.
  const src = fs.readFileSync(__filename, 'utf8').replace(/^const VERSION = .*$/m, `const VERSION = '${VERSION}'; // copied by monish pair`);
  fs.mkdirSync(P.configDir, { recursive: true, mode: 0o700 });
  writeAtomic(P.script, src, 0o755);
}

function pairProblem(status, data, base) {
  if (status === 404 || status === 400) return data.message || 'That code is not valid or has expired. Open Monish and use the code on screen.';
  if (status === 409 && data.error === 'too_many_computers') {
    return 'This iPhone already has 10 computers. Remove one in Monish (Setup, Computers), then run this again.';
  }
  if (status === 429) return `Too many tries. Try again in ${data.retry_after || 60} seconds.`;
  if (status === 0) return `Could not reach ${hostOf(base)} (${data.message}). Check the connection and run the command again.`;
  return `${hostOf(base)} answered ${status}${data.error ? ` ${data.error}` : ''}${data.message ? `: ${data.message}` : ''}.`;
}

// Writes our hooks into the Claude Code settings (read and checked by the caller) and says so.
function writeOurHooks(raw, settings) {
  const had = Object.keys(ourEntries(settings)).length > 0;
  try {
    addOurHooks(settings);
    const target = writeSettings(P.settings, raw, settings, true);
    say(
      `Claude Code hooks ${had ? 'updated in' : 'added to'} ${tilde(P.settings)}` +
        `${target !== P.settings ? ` (link to ${tilde(target)})` : ''}${raw !== null ? ' (backup saved)' : ''}.`,
    );
  } catch (e) {
    fail(
      `Could not write ${tilde(P.settings)} (${e.code || e.message}). Add this to it by hand, ` +
        `merged with your existing "hooks":\n${ourHooksSnippet().replace(/^/gm, '    ')}`,
    );
  }
  for (const cmd of otherPermissionHooks(P.settings, process.cwd(), null)) say(otherHookNote(cmd));
  if (pluginOutdated()) say('Your Monish plugin for Claude Code is out of date: run /plugin update monish in Claude Code, or it pings a second time.');
  if (process.platform === 'win32') say('Windows support is in beta.');
  say('Start claude as usual. To check the setup: npx monish status');
}

async function cmdPair(args, flags) {
  const code = args.join('').replace(/[\s-]/g, '');
  const usage = 'Usage: npx monish pair <code>, with the 6-digit code shown in the Monish app.';
  if (code && !/^\d{6}$/.test(code)) fail(usage);
  if (!exists(P.claudeDir) && !onPath('claude')) {
    fail(`Claude Code settings not found in ${tilde(P.claudeDir)}. Install Claude Code, then run this again.`);
  }
  // Check the settings file before using the code, so the code stays valid if it cannot be written.
  const { raw, settings, error } = readSettings();
  const shape = error || hooksShapeError(settings);
  if (shape) {
    fail(
      `${tilde(P.settings)} was left untouched because ${shape}, and this computer was not paired.\n` +
        `Fix the file, or add this to it by hand (merge with your existing "hooks"), then run npx monish pair ${code || '<code>'} again:\n` +
        ourHooksSnippet().replace(/^/gm, '    '),
    );
  }

  const base = String(flags.api || API).replace(/\/+$/, '');
  const claudeVersion = readClaudeVersion();
  claudeHeader = claudeVersion;
  const old = readComputer();

  // Already paired (running the install line again to update, say): keep this computer and its always
  // rules, rewrite the hooks only. The code is not used. --replace pairs anew and drops the rules.
  if (old && !flags.replace && (!flags.api || base === apiBase(old))) {
    const { status, data } = await http('GET', `${apiBase(old)}/v1/computers/self`, { token: old.token, timeoutMs: 10000 });
    if (status === 200) {
      const comp = isObject(data.computer) ? data.computer : {};
      const name = comp.name || old.name;
      saveComputer({
        ...old,
        name,
        settings: isObject(comp.settings) ? comp.settings : old.settings,
        claude_settings: P.settings,
        claude_version: claudeVersion || old.claude_version || null,
      });
      if (!STANDALONE) installScript();
      const n = Number.isInteger(comp.rules_count) ? comp.rules_count : null;
      say(`Already paired with your iPhone as "${name}"${n ? `: your ${n} always-allowed rule${n > 1 ? 's are' : ' is'} kept` : ''}.`);
      if (code) say(`The code ${code} was not used. To pair this computer with another iPhone instead: npx monish pair <code> --replace (its always-allowed rules are removed).`);
      writeOurHooks(raw, settings);
      return;
    }
    if (status !== 401) {
      fail(`${pairProblem(status, data, apiBase(old))} This computer is still paired; nothing was changed.`);
    }
  }
  if (!code) fail(old ? UNPAIRED : usage);

  const name = computerName(flags.name);
  const body = { code, name, platform: clip(process.platform, 16), cli_version: VERSION };
  if (claudeVersion) body.claude_version = claudeVersion;
  const { status, data } = await http('POST', `${base}/v1/pair`, { body });
  if (status !== 201 && status !== 200) fail(pairProblem(status, data, base));
  if (!/^mc_/.test(String(data.token || ''))) fail(`${hostOf(base)} answered without a computer token. Run the command again.`);

  // Re-pairing: the previous pairing of this computer goes away, with its rules, once the new one exists.
  if (old && old.token !== data.token) {
    const d = await http('DELETE', `${apiBase(old)}/v1/computers/self`, { token: old.token, timeoutMs: 5000 });
    if (d.status === 200) say(`The previous pairing of this computer ("${old.name}") and its always-allowed rules were removed.`);
  }

  const computer = isObject(data.computer) ? data.computer : {};
  saveComputer({
    token: data.token,
    computer_id: computer.id || null,
    name: computer.name || name,
    api_base: flags.api ? base : String(data.api_base || base).replace(/\/+$/, ''),
    paired_at: computer.paired_at || new Date().toISOString(),
    settings: isObject(computer.settings) ? computer.settings : DEFAULT_SETTINGS,
    claude_settings: P.settings,
    claude_version: claudeVersion,
  });
  if (!STANDALONE) installScript();
  // No an_ key saved: the computer token serves `monish ping` and the skill. A computer token left by
  // an earlier pairing died with it, so it is replaced; an an_ key is never touched.
  if (!exists(P.keyFile) || isComputerToken(readText(P.keyFile))) writeAtomic(P.keyFile, data.token, 0o600);

  say('Paired with your iPhone.');
  writeOurHooks(raw, settings);
}

async function cmdStatus() {
  say(`Monish ${VERSION}`);
  let ok = true;
  const c = readComputer();
  const settingsFile = (c && c.claude_settings) || P.settings;
  const claudeVersion = readClaudeVersion();
  if (!c) {
    ok = false;
    say('Paired: no. Open Monish on your iPhone, then run npx monish pair <code> with the code it shows.');
  } else {
    claudeHeader = claudeVersion || c.claude_version || null;
    const { status, data } = await http('GET', `${apiBase(c)}/v1/computers/self`, { token: c.token, timeoutMs: 10000 });
    if (status === 200) {
      const comp = isObject(data.computer) ? data.computer : {};
      const phone = isObject(data.phone) ? data.phone : {};
      const fresh = { ...c, name: comp.name || c.name, settings: isObject(comp.settings) ? comp.settings : c.settings };
      if (claudeVersion) fresh.claude_version = claudeVersion;
      saveComputer(fresh);
      const s = { ...DEFAULT_SETTINGS, ...fresh.settings };
      say(`Paired: yes, as "${fresh.name}" on ${hostOf(apiBase(c))}`);
      say(
        `iPhone: Monish ${phone.app_version || '(version unknown)'}` +
          (phone.requests === false ? ', too old to answer from the phone: update it from the App Store (until then you get a ping)' : '') +
          (phone.notifications === false ? ', notifications not allowed yet' : ''),
      );
      const min = Math.round(Number(s.answer_window_s) / 60);
      say(
        `Answer window: ${min >= 1 ? `${min} min` : `${s.answer_window_s} s`} (set in Monish on your iPhone). ` +
          `Quiet at the keyboard: ${s.quiet_at_keyboard === false ? 'off' : 'on'}.`,
      );
      if (Number.isInteger(comp.rules_count)) {
        const n = comp.rules_count;
        say(`Always allowed: ${n === 0 ? 'nothing yet' : `${n} rule${n > 1 ? 's' : ''}, listed in Monish (Setup, Computers, ${fresh.name})`}.`);
      }
    } else if (status === 401) {
      ok = false;
      say(`Paired: no. ${UNPAIRED}`);
    } else {
      ok = false;
      say(`Paired: yes, as "${c.name}", but ${hostOf(apiBase(c))} could not be checked (${status || data.message}).`);
    }
  }

  const { settings, error } = readSettingsAt(settingsFile);
  if (error) {
    ok = false;
    say(`Claude Code hooks: ${tilde(settingsFile)} cannot be read (${error}).`);
  } else {
    const ours = ourEntries(settings);
    const n = HOOKS.filter((h) => ours[h.event]).length;
    if (n < HOOKS.length) ok = false;
    say(`Claude Code hooks: ${n} of ${HOOKS.length} in ${tilde(settingsFile)}${n < HOOKS.length && c ? '. Run npx monish pair again to restore them.' : ''}`);
    const entry = Object.values(ours)[0];
    if (entry && isBinaryHook(entry)) {
      const binOk = exists(entry.command);
      if (!binOk) ok = false;
      say(`Monish binary: ${tilde(entry.command)}${binOk ? '' : ' is missing. Install Monish again (https://monish.cc/install.sh).'}`);
    } else if (entry) {
      const nodeOk = exists(entry.command);
      const scriptOk = Array.isArray(entry.args) && exists(entry.args[0]);
      if (!nodeOk || !scriptOk) ok = false;
      say(`Node: ${tilde(entry.command)}${nodeOk ? '' : ' is missing (Node moved?). Run npx monish pair again to fix it.'}`);
      if (!scriptOk) say(`Hook script missing: ${tilde(String((entry.args || [])[0]))}. Run npx monish pair again.`);
    }
  }
  say(`Claude Code: ${claudeVersion || 'not found on PATH'} (tested with ${TESTED_CLAUDE})`);
  for (const cmd of otherPermissionHooks(settingsFile, process.cwd(), null)) say(otherHookNote(cmd));
  if (pluginOutdated()) say('Your Monish plugin for Claude Code is out of date: run /plugin update monish in Claude Code, or it pings a second time.');
  if (process.platform === 'win32') say('Windows support is in beta.');
  process.exitCode = ok ? 0 : 1;
}

async function cmdTest() {
  const c = readComputer();
  if (!c) fail('This computer is not paired. Open Monish on your iPhone, then run npx monish pair <code> with the code it shows.');
  claudeHeader = c.claude_version || null;
  const body = {
    kind: 'permission',
    delivery: 'alert',
    agent: clip(`Claude Code · ${c.name || 'Computer'}`, 40),
    session: { id: '00000000', project: clip(project(), 40), title: null, agent_type: null },
    test: true,
    permission: { tool: 'Bash', content: 'echo "Hello from Monish"', description: null, always: null, new_file: false, plan: null },
  };
  const { status, data } = await http('POST', `${apiBase(c)}/v1/requests`, { token: c.token, body });
  if (status === 409 && data.error === 'app_update_required') fail('Your iPhone has an older Monish: update it from the App Store, then run this again.');
  if (status === 401) fail(UNPAIRED);
  if (status !== 201 && status !== 200) fail(pairProblem(status, data, apiBase(c)));
  installSignalHandlers();
  CANCEL.reqId = data.id;
  const waitS = Math.min(Number(data.wait_s) || 120, MAX_WAIT_S);
  say(`Sent a test request to your iPhone. Allow or deny it there (waiting ${waitS >= 120 ? `${Math.round(waitS / 60)} minutes` : `${waitS} s`}).`);
  const t0 = Date.now();
  const res = await waitAnswer(c, { created: t0 }, data, () => null);
  const s = Math.max(1, Math.round((Date.now() - t0) / 1000));
  if (res.end === 'answer') {
    const st = String(res.answer.status || '');
    say(st.startsWith('allow') || st.startsWith('approve') ? `Allowed from your iPhone in ${s} s. Nothing was run.` : `Denied from your iPhone in ${s} s. Nothing was run.`);
    return;
  }
  process.exitCode = 1;
  if (res.end === 'timeout') {
    await closeRequest(c, data.id, 'timeout');
    say(`No answer from your iPhone in ${waitS >= 120 ? `${Math.round(waitS / 60)} minutes` : `${waitS} s`}. Nothing was run.`);
    say('Check that Monish is allowed to send notifications, then run npx monish test again.');
  } else if (res.end === 'local') {
    await closeRequest(c, data.id, 'cancelled');
    say('Stopped. Nothing was run.');
  } else {
    say(`The request was closed (${res.state}). Nothing was run.`);
  }
}

function removeFile(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function cmdUninstall(flags) {
  say('Monish uninstall');
  const c = readComputer();
  let removed = 0;
  for (const file of [...new Set([P.settings, c && c.claude_settings].filter(Boolean))]) {
    const { raw, settings, error } = readSettingsAt(file);
    if (raw === null) continue;
    if (error || (settings.hooks !== undefined && !isObject(settings.hooks))) {
      step(`${tilde(file)} was left untouched because ${error || 'its "hooks" is not an object'}: remove the hooks that run ${OUR_SCRIPT} by hand.`);
      continue;
    }
    const n = removeOurHooks(settings, flags.all);
    if (!n) continue;
    writeSettings(file, raw, settings, false);
    removed += n;
    step(`Removed ${n} Monish hook${n > 1 ? 's' : ''} from ${tilde(file)}`);
  }
  if (!removed) step('No Monish hooks in the Claude Code settings');

  if (c) {
    claudeHeader = c.claude_version || null;
    const { status, data } = await http('DELETE', `${apiBase(c)}/v1/computers/self`, { token: c.token, timeoutMs: 8000 });
    if (status === 200) step(`Unpaired: "${c.name}" no longer reaches your iPhone`);
    else if (status === 401) step('Already unpaired from your iPhone');
    else step(`Could not reach ${hostOf(apiBase(c))} (${status || data.message}): remove "${c.name}" in Monish (Setup, Computers)`);
  }
  // The key file keeps an an_ key (skill, Codex, scripts); a computer token it may hold (this pairing's
  // or an older one's) dies with the pairing.
  const dropKey = flags.all || isComputerToken(readText(P.keyFile));
  for (const f of [P.computer, P.script, P.runDir, P.log, `${P.log}.1`, ...(dropKey ? [P.keyFile] : [])]) {
    if (exists(f) && removeFile(f)) step(`Deleted ${tilde(f)}`);
  }
  if (flags.all) {
    if (exists(P.hookFile) && removeFile(P.hookFile)) step(`Deleted ${tilde(P.hookFile)}`);
    const skillDir = path.dirname(P.skillFile);
    if (exists(skillDir) && removeFile(skillDir)) step(`Deleted ${tilde(skillDir)}`);
    const agents = readText(P.codexAgents);
    if (agents !== null && agents.includes('monish.cc/skill')) {
      const next = agents.replace(/\n?## Monish\n\n[^\n]*monish\.cc\/skill[^\n]*\n?/, ''); // setup appended it after one blank line
      if (next.trim() === '') removeFile(P.codexAgents);
      else fs.writeFileSync(P.codexAgents, next);
      step(`Removed the Monish rule from ${tilde(P.codexAgents)}`);
    }
    const cursorRule = path.join(process.cwd(), '.cursor', 'rules', 'monish.mdc');
    if ((readText(cursorRule) || '').includes('monish.cc/skill') && removeFile(cursorRule)) step(`Deleted ${path.relative(process.cwd(), cursorRule)}`);
  }
  try {
    if (fs.readdirSync(P.configDir).length === 0) fs.rmdirSync(P.configDir);
  } catch {
    // already gone
  }
  say(
    flags.all
      ? 'Done. Monish is removed from this computer' +
          (STANDALONE ? `, except the monish command itself: delete ${tilde(process.execPath)} and ${process.platform === 'win32' ? 'its folder from your user Path' : 'the line marked "# added by monish" in your shell startup file'}` : '') +
          '. To erase the iPhone side too, use Delete account in the app.'
      : `Done. ${dropKey ? 'The' : 'Your key, the'} skill and the Codex and Cursor rules are kept, if any (npx monish uninstall --all removes them too).`,
  );
}

// ---------------------------------------------------------------- hooks, run by Claude Code
//
// Never block Claude Code with an error: every failure ends in "no decision" (exit 0, empty stdout),
// which leaves the dialog, the question or the form in the terminal.

function logLine(msg) {
  try {
    fs.mkdirSync(P.configDir, { recursive: true, mode: 0o700 });
    try {
      if (fs.statSync(P.log).size > 100 * 1024) fs.renameSync(P.log, `${P.log}.1`);
    } catch {
      // no log yet
    }
    fs.appendFileSync(P.log, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {
    // logging never matters more than the hook
  }
}

function readStdin(ms = 5000) {
  return new Promise((resolve) => {
    let data = '';
    const t = setTimeout(() => resolve(data), ms);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (data += d));
    process.stdin.on('end', () => (clearTimeout(t), resolve(data)));
    process.stdin.on('error', () => (clearTimeout(t), resolve(data)));
  });
}

// --- markers in run/: how a waiting hook learns that its request was settled elsewhere.
// Claude Code never tells a hook that the user answered in the terminal or that another hook decided.

const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const fingerprint = (toolInput) => sha(JSON.stringify(sortKeys(toolInput ?? null))).slice(0, 16);
const session8 = (input) => sha(input.session_id || 'none').slice(0, 8);
const agentOf = (input) => (input.agent_id ? String(input.agent_id).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || 'agent' : 'main');
const MARK = {
  post: (s, agent, fp) => `${s}.${agent}.post.${fp}`, // the tool ran (allowed at the keyboard or by another hook)
  prompt: (s) => `${s}.all.prompt.0`, // the user typed a new prompt
  stop: (s) => `${s}.main.stop.0`, // the main agent's turn ended
};
const markerPath = (name) => path.join(P.runDir, name);
function touch(name) {
  try {
    fs.mkdirSync(P.runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(markerPath(name), '');
  } catch {
    // a missing marker only delays the closing until the deadline
  }
}
function mtimeOf(name) {
  try {
    return fs.statSync(markerPath(name)).mtimeMs;
  } catch {
    return 0;
  }
}
function sweepRun() {
  try {
    for (const f of fs.readdirSync(P.runDir)) {
      const p = markerPath(f);
      if (Date.now() - fs.statSync(p).mtimeMs > 2 * 3600 * 1000) fs.unlinkSync(p);
    }
  } catch {
    // nothing to sweep
  }
}

// --- presence: the last keystroke in Claude's own terminal (atime of its tty), or the machine-wide
// idle time when there is no terminal (macOS HIDIdleTime, Windows GetLastInputInfo).

function findTty() {
  if (process.platform === 'win32') return null;
  let pid = process.ppid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    const r = spawnSync('ps', ['-o', 'tty=,ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000 });
    const [tty, ppid] = String(r.stdout || '').trim().split(/\s+/);
    if (!tty) return null;
    if (!/^\?+$/.test(tty) && tty !== '-') {
      const dev = tty.startsWith('/dev/') ? tty : `/dev/${tty}`;
      return exists(dev) ? dev : null;
    }
    pid = Number(ppid);
  }
  return null;
}

const WIN_IDLE_PS =
  'Add-Type @"\nusing System;using System.Runtime.InteropServices;public static class MonishIdle{' +
  '[StructLayout(LayoutKind.Sequential)]struct L{public uint s;public uint t;}' +
  '[DllImport("user32.dll")]static extern bool GetLastInputInfo(ref L l);' +
  'public static uint Ms(){L l=new L();l.s=(uint)Marshal.SizeOf(l);GetLastInputInfo(ref l);return (uint)Environment.TickCount-l.t;}}\n"@\n[MonishIdle]::Ms()';

function globalIdleS() {
  try {
    if (process.platform === 'darwin') {
      const r = spawnSync('ioreg', ['-c', 'IOHIDSystem', '-d', '4', '-r', '-k', 'HIDIdleTime'], { encoding: 'utf8', timeout: 3000 });
      const m = String(r.stdout || '').match(/"HIDIdleTime"\s*=\s*(\d+)/);
      return m ? Number(m[1]) / 1e9 : null;
    }
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WIN_IDLE_PS], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const out = String(r.stdout || '').trim();
      return /^\d+$/.test(out) ? Number(out) / 1000 : null;
    }
  } catch {
    // unknown presence
  }
  return null;
}

function presenceNow(c) {
  const p = { source: 'none', tty: null, atime0: null, idle: null };
  const tty = findTty();
  if (tty) {
    try {
      p.atime0 = fs.statSync(tty).atimeMs;
      p.idle = (Date.now() - p.atime0) / 1000;
      p.source = 'tty';
      p.tty = tty;
    } catch {
      // unreadable terminal
    }
  }
  if (p.source === 'none') {
    const g = globalIdleS();
    if (g !== null) Object.assign(p, { source: 'global', idle: g });
  }
  p.state = !quietOn(c) ? 'absent' : p.source === 'none' ? 'unknown' : p.idle >= IDLE_S ? 'absent' : 'present';
  return p;
}

let lastGlobalCheck = 0;
function idleNow(p) {
  if (p.source === 'tty') {
    try {
      return (Date.now() - fs.statSync(p.tty).atimeMs) / 1000;
    } catch {
      return null;
    }
  }
  if (p.source === 'global' && Date.now() - lastGlobalCheck >= (process.platform === 'win32' ? 10000 : 3000)) {
    lastGlobalCheck = Date.now();
    return globalIdleS();
  }
  return null;
}

function typedSince(p) {
  if (p.source !== 'tty') return false;
  try {
    return fs.statSync(p.tty).atimeMs > p.atime0;
  } catch {
    return false;
  }
}

// Claude Code gone -> cancelled; a keystroke in its terminal -> answered_on_computer. A closing
// terminal also moves the atime (Claude Code reads the hang-up), so a keystroke is confirmed on the
// next check, once Claude Code had time to exit.
function terminalCheck(ctx) {
  if (parentGone(ctx)) return 'cancelled';
  if (!typedSince(ctx.presence)) return null;
  if (!ctx.typedAt) ctx.typedAt = Date.now();
  return Date.now() - ctx.typedAt >= 400 ? 'answered_on_computer' : null;
}

// --- signals and the parent: Claude Code stopped or killed while the iPhone was asked.

const CANCEL = { reason: null, reqId: null, onSignal: null };
function installSignalHandlers() {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        CANCEL.reason = 'cancelled';
        if (!CANCEL.reqId) process.exit(0);
        if (CANCEL.onSignal) CANCEL.onSignal();
        setTimeout(() => process.exit(0), 2500).unref();
      });
    } catch {
      // signal not supported on this platform
    }
  }
}

// Claude Code started with -p / --print (scripts, CI, the Agent SDK's streaming input).
// The Claude desktop app also drives Claude Code over streaming input, with someone in front of
// it: its sessions are not scripts.
function printMode(ppid) {
  if (process.env.CLAUDE_CODE_ENTRYPOINT === 'claude-desktop') return false;
  try {
    const r =
      process.platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}").CommandLine`], {
            encoding: 'utf8',
            timeout: 8000,
            windowsHide: true,
          })
        : spawnSync('ps', ['-o', 'args=', '-p', String(ppid)], { encoding: 'utf8', timeout: 2000 });
    return /(^|\s)(-p|--print|--input-format)(\s|=|$)/.test(String(r.stdout || ''));
  } catch {
    return false;
  }
}

function parentGone(ctx) {
  if (process.ppid !== ctx.ppid) return true;
  try {
    process.kill(ctx.ppid, 0);
    return false;
  } catch (e) {
    return e.code === 'ESRCH';
  }
}

// --- requests

// 12 hex of sha256(absolute cwd): the project a rule is bound to; the path never leaves the computer.
const cwdOf = (input) => path.resolve(String(input.cwd || process.cwd()));
const projectIdOf = (input) => sha(cwdOf(input)).slice(0, 12);
const projectOf = (input) => clip(path.basename(cwdOf(input)) || 'shell', 40);

function context(input, c, event) {
  const s8 = session8(input);
  const proj = projectOf(input);
  const st = readJSON(markerPath(`${s8}.session.json`)) || {};
  return {
    event,
    s8,
    agent: agentOf(input),
    project: proj,
    started: Date.now(),
    ppid: process.ppid,
    agentLabel: clip(`Claude Code · ${proj}`, 40),
    session: {
      id: s8,
      project: proj,
      project_id: projectIdOf(input),
      title: typeof st.title === 'string' && st.title ? clip(st.title, 60) : null,
      agent_type: input.agent_type ? clip(String(input.agent_type), 30) : null,
    },
    promptAt: Number(st.prompt_at) || null,
    presence: presenceNow(c),
  };
}

// { req } a request was created; { rule } an always / session rule answered without one (200, id
// null); { none } a dry run found no rule; { error } anything else.
async function createRequest(c, body) {
  const url = `${apiBase(c)}/v1/requests`;
  let r = await http('POST', url, { token: c.token, body });
  if (r.status === 0 && !CANCEL.reason) {
    await sleep(2000);
    r = await http('POST', url, { token: c.token, body });
  }
  if (r.status === 201 || r.status === 200) refreshSettings(c, r.data.settings);
  if ((r.status === 201 || r.status === 200) && typeof r.data.id === 'string') return { req: r.data };
  if (r.status === 200 && r.data.state === 'answered' && isObject(r.data.answer)) return { rule: r.data.answer };
  if (r.status === 200 && r.data.state === 'none') return { none: true };
  return { error: r };
}

const closeRequest = (c, id, reason) =>
  http('POST', `${apiBase(c)}/v1/requests/${id}/close`, { token: c.token, body: { reason }, timeoutMs: reason === 'cancelled' ? 2000 : 8000 });

// Long-polls the answer; every second, settled() looks for an answer given elsewhere and onTick()
// may turn a note into an alert. Ends with { end: answer | local | timeout | gone }.
async function waitAnswer(c, ctx, req, settled, onTick) {
  const deadline = ctx.created + Math.min(Number(req.wait_s) || DEFAULT_SETTINGS.answer_window_s, MAX_WAIT_S) * 1000;
  const ctl = new AbortController();
  let local = null;
  const check = () => {
    if (local) return;
    local = CANCEL.reason || settled();
    if (local) ctl.abort();
    else if (onTick) onTick();
  };
  CANCEL.onSignal = check;
  const timer = setInterval(check, 1000);
  try {
    while (!local) {
      const left = deadline - Date.now();
      if (left <= 0) return { end: 'timeout' };
      const wait = Math.max(0, Math.min(25, Math.floor(left / 1000)));
      const t0 = Date.now();
      const r = await http('GET', `${apiBase(c)}/v1/requests/${req.id}?wait=${wait}`, { token: c.token, signal: ctl.signal, timeoutMs: (wait + 15) * 1000 });
      if (local) break;
      if (r.status === 200 && r.data.state === 'answered' && isObject(r.data.answer)) return { end: 'answer', answer: r.data.answer };
      if (r.status === 200 && r.data.state && r.data.state !== 'open') return { end: 'gone', state: r.data.closed_reason || r.data.state };
      if (r.status === 401 || r.status === 404) return { end: 'gone', state: r.data.error || r.status };
      if (r.status !== 200) await sleep(2000, ctl.signal);
      else if (Date.now() - t0 < 1000) await sleep(Math.min(1000, Math.max(0, deadline - Date.now())), ctl.signal);
    }
    return { end: 'local', reason: local };
  } finally {
    clearInterval(timer);
    CANCEL.onSignal = null;
  }
}

// Closes the request when it ended on this computer; if the iPhone's answer slipped in first, use it.
async function finish(c, ctx, req, res, toOutput, recover = true) {
  if (res.end === 'answer') {
    logLine(`${ctx.event} ${req.id} answered ${res.answer.status}`);
    return toOutput(res.answer);
  }
  if (res.end === 'gone') {
    logLine(`${ctx.event} ${req.id} gone ${res.state}`);
    return null;
  }
  const reason = res.end === 'timeout' ? 'timeout' : res.reason;
  const r = await closeRequest(c, req.id, reason);
  logLine(`${ctx.event} ${req.id} closed ${reason} (${r.status} ${r.data.state || r.data.error || ''})`);
  if (recover && reason !== 'cancelled' && r.status === 200 && r.data.state === 'answered') {
    const g = await http('GET', `${apiBase(c)}/v1/requests/${req.id}?wait=0`, { token: c.token, timeoutMs: 8000 });
    if (g.status === 200 && g.data.state === 'answered' && isObject(g.data.answer)) return toOutput(g.data.answer);
  }
  return null;
}

function unpairedNotice() {
  const name = 'unpaired-notice';
  if (Date.now() - mtimeOf(name) < 24 * 3600 * 1000) return null;
  touch(name);
  return { stdout: { systemMessage: 'Monish: this computer was unpaired from your iPhone. Run npx monish pair to pair again.' } };
}

// The iPhone runs Monish 1.0.x and cannot answer: send the old "Needs you" ping, the terminal decides.
async function createFailed(c, ctx, r = { status: 0, data: {} }, legacyBody) {
  const err = r.data.error || r.data.message || '';
  logLine(`${ctx.event} create failed ${r.status} ${err}`);
  if (r.status === 409 && err === 'app_update_required' && legacyBody) {
    const slug = ctx.project.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 58);
    const s = await http('POST', `${apiBase(c)}/v1/send`, {
      token: c.token,
      body: { id: `needs-${slug}`, type: 'done', title: `Needs you · ${ctx.project}`, body: clip(legacyBody, 200), agent: ctx.agentLabel, fields: { severity: 'warning' } },
      timeoutMs: 8000,
    });
    logLine(`${ctx.event} legacy ping ${s.status}`);
  }
  if (r.status === 401) return unpairedNotice();
  return null;
}

function relPath(p, cwd) {
  if (typeof p !== 'string') return '';
  if (!path.isAbsolute(p)) return p;
  const rel = path.relative(cwd, p);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : tilde(p);
}

// What "Always allow" and "Allow for this session" would cover (contract v2 § 1.1), or null.
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
// Read-only tools ask only for a path outside the project: a rule on the tool would open the whole disk.
const NO_RULE_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'ExitPlanMode', 'AskUserQuestion'];
// Files that change what Claude Code, git or an editor run or allow: every edit there is asked, rule or not.
const CONFIG_DIRS = ['.claude', '.git', '.vscode', '.idea', '.husky'];
const CONFIG_FILES = ['.mcp.json', '.envrc'];
const CASELESS = process.platform === 'darwin' || process.platform === 'win32';
const norm = (p) => (CASELESS ? p.toLowerCase() : p);

function realOrSelf(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

// The real path of a file that may not exist yet: its nearest existing folder, resolved, plus the rest.
function realTarget(file) {
  let dir = file;
  const rest = [];
  while (!exists(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return file;
    rest.unshift(path.basename(dir));
    dir = up;
  }
  return path.join(realOrSelf(dir), ...rest);
}

// The home folder, a folder above it or a disk root is not a project: no rule there, for any tool.
function broadFolder(cwd) {
  const c = norm(realOrSelf(cwd));
  if (path.parse(c).root === c) return true;
  const homes = [os.homedir()];
  try {
    homes.push(os.userInfo().homedir);
  } catch {
    // no passwd entry
  }
  return homes.filter(Boolean).some((h) => {
    const home = norm(realOrSelf(path.resolve(h)));
    return home === c || home.startsWith(c.endsWith(path.sep) ? c : c + path.sep);
  });
}

// A file of the project that is not a config file, or null.
function insideProject(cwd, file) {
  const rel = path.relative(cwd, file);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const parts = norm(rel).split(/[\\/]+/);
  if (parts.some((s) => CONFIG_DIRS.includes(s)) || CONFIG_FILES.includes(parts[parts.length - 1])) return null;
  return rel;
}

function alwaysOf(tool, ti, cwd) {
  if (!tool || NO_RULE_TOOLS.includes(tool) || broadFolder(cwd)) return null;
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = typeof ti.command === 'string' ? ti.command : '';
    if (ti.dangerouslyDisableSandbox === true) return null; // a rule would also cover the sandboxed run
    return cmd && cmd.length <= 2000 ? { scope: 'command', value: cmd } : null; // a cut command is no longer exact
  }
  if (tool === 'WebFetch') {
    try {
      const host = new URL(String(ti.url)).hostname.toLowerCase();
      return host ? { scope: 'site', value: host } : null;
    } catch {
      return null;
    }
  }
  if (EDIT_TOOLS.includes(tool)) {
    const file = ti.notebook_path || ti.file_path;
    if (typeof file !== 'string' || !file) return null;
    const abs = path.resolve(cwd, file);
    // Both the path as written and where it really lands (a link in the project may point elsewhere).
    const ok = insideProject(cwd, abs) && insideProject(realOrSelf(cwd), realTarget(abs));
    return ok ? { scope: 'edits', value: '*' } : null;
  }
  return { scope: 'tool', value: clip(tool, 200) }; // mcp__…, WebSearch, any other tool
}

// ---- diff preview of a file edit (permission.preview): a few lines under the path on the phone.
// These lines leave the computer: when in doubt a value is hidden, and a doubtful file sends none.
const PREVIEW_LINES = 12;
const PREVIEW_LINE_MAX = 120;
const PREVIEW_MASK_WINDOW = 400; // a line is cut here before the masks run (a giant line costs nothing), then at 120
const PREVIEW_BYTES = 2048;
const PREVIEW_FILE_MAX = 512 * 1024; // a larger file being rewritten is sent as a path only
// Files whose lines are secrets by nature, by name or by folder: path only.
const SECRET_FILE =
  /(^|[\\/])(\.env[^\\/]*|[^\\/]*\.env|\.dev\.vars[^\\/]*|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.htpasswd|\.git-credentials|auth\.json|kubeconfig[^\\/]*|wp-config[^\\/]*|id_(rsa|dsa|ecdsa|ed25519)[^\\/]*|[^\\/]*(secret|credential|adminsdk|service[-_]account)[^\\/]*|[^\\/]*\.(pem|key|p8|p12|pfx|keystore|jks|tfvars|tfstate|kdbx|ovpn|gpg|asc))$/i;
const SECRET_DIR = /(^|[\\/])(\.ssh|\.kube|\.docker|\.aws|\.gnupg|secrets?)[\\/]/i;
const secretFile = (p) => SECRET_FILE.test(p) || SECRET_DIR.test(p);

// What a phone line must not carry: control characters (dropped), and the invisible characters that
// reorder or hide text (bidi controls, zero width: shown as \ufffd, so the line reads as the code is).
const cleanLine = (s) =>
  wellFormed(s.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '')).replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '\ufffd');

const KNOWN_KEYS =
  /\b(sk-[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}|npm_[A-Za-z0-9]{16,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abeprs]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|A(?:KIA|SIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|(?:mc|mp|an)_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*)/g;
// A name that says key, token, secret, password…: whatever it is given is hidden, to the end of the line.
const SENSITIVE = '[A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|PWD|_PASS|AUTH|CREDENTIAL|PRIVATE|SIGNATURE)[A-Za-z0-9_.-]*';
const NAME_VALUE = new RegExp(`(${SENSITIVE}["'\`\\])]*\\s*(?:=>|[=:]+)\\s*)\\S.*$`, 'i'); // NAME = v, "name": v, name: Type = v
const NAME_ARG = new RegExp(`(${SENSITIVE}\\s*\\(\\s*)["'\`].*$`, 'i'); // setPassword("v")
const NAME_PAIR = new RegExp(`(["'\`]${SENSITIVE}["'\`]\\s*,\\s*)\\S.*$`, 'i'); // define('DB_PASSWORD', 'v')
const NAME_ALONE = new RegExp(`${SENSITIVE}["'\`\\])]*\\s*(?:=>|[=:(,]+)\\s*$`, 'i'); // the value is on the next line
// A long run of letters and digits with no words in it (base64, hex, a key body): digits in two places
// or more, or 32 characters mixing cases and digits, or 16 digits in a row.
const looksRandom = (t) =>
  (/[A-Za-z]/.test(t) && (t.match(/\d+/g) || []).length >= 2) || (t.length >= 32 && /[a-z]/.test(t) && /[A-Z]/.test(t) && /\d/.test(t)) || /\d{16,}/.test(t);

// A line of code can carry a secret. `st` runs from line to line: the body of a private key is hidden
// until its END line, and so is the line after a sensitive name left alone. The name stays, never the value.
function maskCode(line, st = {}) {
  if (st.key) {
    if (/-----END [A-Z0-9 ]*-----/.test(line)) st.key = false;
    return '•••';
  }
  if (st.next) {
    st.next = false;
    return line.trim() ? '•••' : line;
  }
  const begin = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/.exec(line);
  if (begin) {
    st.key = !/-----END [A-Z0-9 ]*-----/.test(line.slice(begin.index + begin[0].length));
    return `${line.slice(0, begin.index)}•••`;
  }
  st.next = NAME_ALONE.test(line);
  return line
    .replace(KNOWN_KEYS, '•••')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 •••')
    .replace(/(\/\/[^\s:@\/]*:)[^\s@]+@/g, '$1•••@')
    .replace(/(hooks\.slack\.com\/services\/)\S+/gi, '$1•••')
    .replace(NAME_VALUE, '$1•••')
    .replace(NAME_ARG, '$1•••')
    .replace(NAME_PAIR, '$1•••')
    .replace(/[A-Za-z0-9+\/=_-]{24,}/g, (t) => (looksRandom(t) ? '•••' : t));
}

const linesOf = (text) => {
  if (text === '') return [];
  const l = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (l.length > 1 && l[l.length - 1] === '') l.pop(); // the newline that ends the text is not a line
  return l;
};

// The lines that differ between two texts, in order: what both share is left out (longest common
// subsequence between the common start and end; past 400 lines a side, the whole middle is changed).
function changedLines(before, after) {
  const a = linesOf(before);
  const b = linesOf(after);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const x = a.slice(head, a.length - tail);
  const y = b.slice(head, b.length - tail);
  const out = [];
  if (x.length > 400 || y.length > 400) return [...x.map((text) => ({ op: '-', text })), ...y.map((text) => ({ op: '+', text }))];
  const lcs = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) {
    for (let j = y.length - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      i++;
      j++;
    } else if (i < x.length && (j === y.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  return out;
}

// What an Edit, a MultiEdit or a Write over an existing file changes: the removed and added lines
// of each change, in order, at most 12 lines of 120 characters and 2 KB, what looks like a secret hidden.
// Null (the phone shows the path alone) for a new file, a secret file, a binary, a huge one or anything
// that is not a regular file.
function previewOf(tool, ti, cwd) {
  try {
    if (!['Edit', 'MultiEdit', 'Write'].includes(tool) || typeof ti.file_path !== 'string' || !ti.file_path) return null;
    if (secretFile(ti.file_path) || secretFile(path.resolve(cwd, ti.file_path))) return null;
    let hunks;
    if (tool === 'Write') {
      const file = path.resolve(cwd, ti.file_path);
      if (typeof ti.content !== 'string' || ti.content.length > PREVIEW_FILE_MAX || !exists(file)) return null;
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > PREVIEW_FILE_MAX) return null; // a pipe or a device says size 0 and never ends
      const current = fs.readFileSync(file, 'utf8');
      if (current.includes('\u0000')) return null;
      hunks = [changedLines(current, ti.content)];
    } else {
      const edits = tool === 'MultiEdit' ? (Array.isArray(ti.edits) ? ti.edits : []) : [ti];
      hunks = edits
        .filter((e) => isObject(e) && typeof e.old_string === 'string' && typeof e.new_string === 'string')
        .map((e) => changedLines(e.old_string, e.new_string));
    }
    const all = hunks.flat();
    if (!all.length) return null;
    // the indentation shared by every line is dropped: a phone line is about forty characters wide
    const indent = Math.min(...all.filter((l) => l.text.trim()).map((l) => l.text.replace(/\t/g, '  ').match(/^ */)[0].length), 1000);
    const lines = [];
    const st = {};
    let bytes = 0;
    for (const l of all) {
      if (lines.length >= PREVIEW_LINES) break;
      // cut first (4 KB, then 400 characters), mask what is left, cut to what is shown: a secret that
      // starts in the 120 shown characters is whole in the window the masks read
      const raw = l.text.trim() ? cleanLine(l.text.slice(0, 4096)).slice(indent) : '';
      const text = clip(maskCode(Array.from(raw.slice(0, 2 * PREVIEW_MASK_WINDOW)).slice(0, PREVIEW_MASK_WINDOW).join(''), st), PREVIEW_LINE_MAX);
      bytes += Buffer.byteLength(text) + 1;
      if (bytes > PREVIEW_BYTES) break;
      lines.push({ op: l.op, text });
    }
    return lines.length ? { kind: 'diff', lines, truncated: lines.length < all.length } : null;
  } catch {
    return null; // a preview is a comfort: the request goes with the path alone
  }
}

function permissionOf(input, ti, tool) {
  const cwd = String(input.cwd || process.cwd());
  let content = null;
  if (tool === 'Bash' || tool === 'PowerShell') content = ti.command;
  else if (['Edit', 'Write', 'MultiEdit', 'Read'].includes(tool)) content = relPath(ti.file_path, cwd);
  else if (tool === 'NotebookEdit') content = relPath(ti.notebook_path || ti.file_path, cwd);
  else if (tool === 'WebFetch') content = ti.url;
  else if (tool === 'WebSearch') content = ti.query;
  else if (tool.startsWith('mcp__')) {
    const [, server, ...rest] = tool.split('__');
    content = `${server} · ${rest.join('__')} ${JSON.stringify(ti)}`;
  }
  const plan = tool === 'ExitPlanMode' && typeof ti.plan === 'string' ? ti.plan : null;
  if (plan !== null) content = ((plan.match(/^#{1,6}\s+(.+)$/m) || [])[1] || '').trim();
  else if (typeof content !== 'string' || !content) content = JSON.stringify(ti);
  const file = tool === 'Write' && typeof ti.file_path === 'string' && ti.file_path ? path.resolve(cwd, ti.file_path) : null;
  return {
    tool: clip(tool, 80),
    content: clip(content, 2000),
    description: typeof ti.description === 'string' && ti.description ? clip(ti.description, 200) : null,
    always: plan === null ? alwaysOf(tool, ti, path.resolve(cwd)) : null,
    new_file: Boolean(file && !exists(file)),
    plan: plan === null ? null : clip(plan, 30000),
    preview: previewOf(tool, ti, path.resolve(cwd)),
  };
}

function questionsOf(ti) {
  const qs = Array.isArray(ti.questions) ? ti.questions : [];
  if (qs.length < 1 || qs.length > 4) return null;
  const out = [];
  for (const q of qs) {
    if (!isObject(q) || typeof q.question !== 'string' || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return null;
    out.push({
      question: clip(q.question, 300),
      header: clip(q.header || '', 30),
      multi_select: q.multiSelect === true,
      options: q.options.map((o) => {
        const opt = { label: clip(isObject(o) ? o.label : o, 60) };
        if (isObject(o) && typeof o.description === 'string' && o.description) opt.description = clip(o.description, 200);
        return opt;
      }),
    });
  }
  return out;
}

// answers = { exact question text: label, labels joined by ", ", or the typed text }
function questionAnswers(questions, answer) {
  if (!Array.isArray(questions)) return null;
  const status = String(answer.status || '');
  let list = isObject(answer.response) && Array.isArray(answer.response.answers) ? answer.response.answers : null;
  if (!list && /^option_\d$/.test(status)) list = [{ selected: [Number(status.slice(7)) - 1] }];
  if (!list && status === 'text' && answer.text) list = [{ text: answer.text }];
  if (!list) return null;
  const out = {};
  questions.forEach((q, i) => {
    const a = list[i];
    if (!isObject(a) || !isObject(q)) return;
    const labels = (Array.isArray(a.selected) ? a.selected : [])
      .map((j) => Array.isArray(q.options) && isObject(q.options[j]) && q.options[j].label)
      .filter((l) => typeof l === 'string');
    const typed = typeof a.text === 'string' && a.text.trim() ? [a.text.trim()] : [];
    const value = [...labels, ...typed].join(', ');
    if (value) out[q.question] = value;
  });
  return Object.keys(out).length ? out : null;
}

function permissionOutput(kind, input, ti, answer) {
  const out = (decision) => ({ stdout: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } } });
  if (kind === 'question') {
    const answers = questionAnswers(ti.questions, answer);
    return answers ? out({ behavior: 'allow', updatedInput: { ...ti, answers } }) : null;
  }
  const status = String(answer.status || '');
  const text = typeof answer.text === 'string' ? answer.text.trim() : '';
  const plan = input.tool_name === 'ExitPlanMode';
  // allow, allow_session, allow_always: the same plain allow, the rule lives on the Worker (contract v2 § 1.3).
  if (status.startsWith('allow') || status === 'approve' || status === 'approved') return out(plan ? { behavior: 'allow', updatedInput: ti } : { behavior: 'allow' });
  if (status === 'deny' || status === 'denied' || status === 'text') {
    let message = text ? `Denied from the user's phone. Reason: ${text}` : "Denied from the user's phone.";
    if (plan) message = text ? `The user wants changes to the plan (from their phone): ${text}` : 'The user rejected the plan from their phone.';
    return out({ behavior: 'deny', message });
  }
  return null;
}

// PermissionRequest: a permission, a plan (ExitPlanMode) or a question (AskUserQuestion).
// The dialog stays in the terminal while this waits: the first answer wins.
async function hookPermission(input, c) {
  const tool = String(input.tool_name || '');
  const ti = isObject(input.tool_input) ? input.tool_input : {};
  const kind = tool === 'AskUserQuestion' ? 'question' : 'permission';
  // Permission notifications off: no request, but an always / session rule still answers.
  const muted = kind === 'question' ? !notifyOf(c).question : !notifyOf(c).permission;
  if (!tool || (muted && kind === 'question')) return null;
  const ctx = context(input, c, 'permission-request');
  const fp = fingerprint(input.tool_input);
  const settled = () => {
    if (mtimeOf(MARK.post(ctx.s8, ctx.agent, fp)) >= ctx.started) return 'answered_on_computer';
    if (mtimeOf(MARK.prompt(ctx.s8)) >= ctx.started) return 'answered_on_computer';
    if (ctx.agent === 'main' && mtimeOf(MARK.stop(ctx.s8)) >= ctx.started) return 'answered_on_computer';
    return terminalCheck(ctx);
  };

  let payload;
  if (kind === 'question') {
    const questions = questionsOf(ti);
    if (!questions) return null; // outside what the iPhone shows: the terminal asks
    payload = { questions };
  } else payload = { permission: permissionOf(input, ti, tool) };

  const always = payload.permission ? payload.permission.always : null;
  const allowOut = () => ({ stdout: { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } } });
  // Only a rule that allows answers; anything else leaves the dialog in the terminal.
  const byRule = (rule, note) => {
    const ok = isObject(rule) && String(rule.status || '').startsWith('allow');
    logLine(`permission-request ${ok ? 'allowed by' : 'ignored'} a rule (${always ? always.scope : '?'}${rule && isObject(rule.rule) && rule.rule.session ? ', session' : ''}${note})`);
    return ok ? allowOut() : null;
  };
  const envelope = (delivery) => ({ kind, delivery, agent: ctx.agentLabel, session: ctx.session, test: false, ...payload });
  if (muted && !always) return null;
  const p = ctx.presence;

  // Another permission hook (an auto-approver, a gatekeeper) gets 10 s first, rule or not: Claude Code
  // takes the first decision (2.1.325), so an allow from a rule must never beat that hook's deny.
  if (otherPermissionHooks(c.claude_settings || P.settings, input.cwd, tool).length > 0) {
    const deadline = Date.now() + GRACE_S * 1000;
    while (Date.now() < deadline) {
      const r = CANCEL.reason || settled();
      if (r) {
        logLine(`permission-request settled before asking the iPhone (${r})`);
        return null;
      }
      await sleep(500);
    }
  }

  if (muted) {
    const dry = await createRequest(c, { ...envelope('note'), dry_run: true });
    if (dry.req) await closeRequest(c, dry.req.id, 'cancelled'); // a server without dry runs created it
    return dry.rule ? byRule(dry.rule, ', notifications off') : null;
  }
  if (p.state === 'present' && (idleNow(p) ?? 0) >= IDLE_S) p.state = 'absent'; // walked away during the grace
  const delivery = p.state === 'present' ? 'note' : 'alert';
  const r = await createRequest(c, envelope(delivery));
  if (r.rule) return byRule(r.rule, '');
  const legacy = kind === 'question' ? 'Claude has a question for you' : `Claude needs your permission to use ${tool}`;
  if (!r.req) return createFailed(c, ctx, r.error, legacy);
  const req = r.req;
  ctx.created = Date.now();
  CANCEL.reqId = req.id;
  logLine(
    `permission-request ${req.id} ${kind}${payload.permission && payload.permission.plan !== null ? ' plan' : ''} ${delivery} ` +
      `wait=${req.wait_s}s presence=${p.source}:${p.state}${always ? ` always=${always.scope}` : ''}`,
  );

  let alerted = delivery === 'alert';
  const onTick = () => {
    if (alerted) return;
    const idle = idleNow(p);
    if (idle === null || idle < IDLE_S) return;
    alerted = true;
    http('POST', `${apiBase(c)}/v1/requests/${req.id}/alert`, { token: c.token, timeoutMs: 8000 }).then((r) =>
      logLine(`permission-request ${req.id} alert after ${Math.round(idle)} s idle (${r.status})`),
    );
  };
  const res = await waitAnswer(c, ctx, req, settled, onTick);
  return finish(c, ctx, req, res, (answer) => permissionOutput(kind, input, ti, answer));
}

// MCP form schema -> at most 4 flat fields the iPhone can show; anything else stays in the terminal.
function formOf(input) {
  if (input.mode && input.mode !== 'form') return null;
  const sch = input.requested_schema;
  if (!isObject(sch) || !isObject(sch.properties)) return null;
  const names = Object.keys(sch.properties);
  if (names.length < 1 || names.length > 4) return null;
  const required = Array.isArray(sch.required) ? sch.required : [];
  const fields = [];
  for (const name of names) {
    const p = sch.properties[name];
    if (!isObject(p) || name.length > 40) return null;
    const f = { name, title: clip(p.title || name, 60), required: required.includes(name) };
    const opts = Array.isArray(p.enum) ? p.enum : Array.isArray(p.oneOf) ? p.oneOf.map((o) => isObject(o) && o.const) : null;
    if (opts) {
      if (opts.length < 2 || opts.length > 8 || opts.some((o) => typeof o !== 'string' || o.length > 60)) return null;
      Object.assign(f, { type: 'enum', options: opts });
    } else if (p.type === 'string') Object.assign(f, { type: 'text', max_length: Math.min(Number(p.maxLength) || 500, 500) });
    else if (p.type === 'number' || p.type === 'integer') {
      f.type = 'number';
      f.integer = p.type === 'integer';
      if (typeof p.minimum === 'number') f.minimum = p.minimum;
      if (typeof p.maximum === 'number') f.maximum = p.maximum;
    } else if (p.type === 'boolean') f.type = 'boolean';
    else return null;
    fields.push(f);
  }
  return { server: clip(input.mcp_server_name || '', 60), message: clip(input.message || '', 500), fields };
}

function elicitationOutput(answer) {
  const st = String(answer.status || '');
  const resp = isObject(answer.response) ? answer.response : {};
  const out = (o) => ({ stdout: { hookSpecificOutput: { hookEventName: 'Elicitation', ...o } } });
  if (st === 'accept' || (st === 'response' && resp.action === 'accept')) return out({ action: 'accept', content: isObject(resp.content) ? resp.content : {} });
  if (st === 'decline' || st === 'deny' || resp.action === 'decline') return out({ action: 'decline' });
  return null;
}

// Elicitation: the form is hidden while the hook waits, so the iPhone is asked only when the user
// is away and a keystroke in the terminal can bring the form back.
async function hookElicitation(input, c) {
  if (!notifyOf(c).question) return null;
  const form = formOf(input);
  if (!form) return null;
  const ctx = context(input, c, 'elicitation');
  const p = ctx.presence;
  if (p.state !== 'absent' || (p.source !== 'tty' && quietOn(c))) return null;
  const settled = () => {
    if (mtimeOf(MARK.prompt(ctx.s8)) >= ctx.started) return 'answered_on_computer';
    return terminalCheck(ctx);
  };
  const body = { kind: 'form', delivery: 'alert', agent: ctx.agentLabel, session: ctx.session, test: false, form };
  const { req, error } = await createRequest(c, body);
  if (!req) return createFailed(c, ctx, error, `Claude needs your input (${form.server})`);
  ctx.created = Date.now();
  CANCEL.reqId = req.id;
  logLine(`elicitation ${req.id} alert presence=${p.source}:${p.state}`);
  const res = await waitAnswer(c, ctx, req, settled, null);
  return finish(c, ctx, req, res, elicitationOutput);
}

// Stop (asyncRewake): the turn summary goes to the iPhone; a reply wakes Claude up (exit 2).
async function hookStop(input, c) {
  const bg = Array.isArray(input.background_tasks) ? input.background_tasks : [];
  if (bg.some((t) => isObject(t) && t.type === 'subagent' && t.status === 'running')) return null; // the final Stop follows
  const ctx = context(input, c, 'stop');
  touch(MARK.stop(ctx.s8)); // closes this session's open requests and the previous turn
  const mine = mtimeOf(MARK.stop(ctx.s8));
  const message = typeof input.last_assistant_message === 'string' ? input.last_assistant_message.trim() : '';
  await sessionEvent(c, input, 'stop', { message: message ? clip(message.replace(/\s+/g, ' '), 120) : null });
  if (!notifyOf(c).turn_end) return null;
  if (!message) return null;
  // claude -p waits for this hook before printing its result: a scripted run never waits for the iPhone.
  if (printMode(ctx.ppid)) return null;
  await sleep(2000); // a run that ends now (Esc, quit) ends this hook too: nothing is sent then
  if (mtimeOf(MARK.stop(ctx.s8)) > mine) return null;
  const p = ctx.presence;
  if (p.state === 'present') return null;
  const delivery = p.state === 'absent' ? 'alert' : 'note';
  const duration = ctx.promptAt ? Math.max(0, Math.round((Date.now() - ctx.promptAt) / 1000)) : null;
  const body = { kind: 'turn', delivery, agent: ctx.agentLabel, session: ctx.session, test: false, turn: { message: clip(message, 4000), duration_s: duration } };
  const { req, error } = await createRequest(c, body);
  if (!req) return createFailed(c, ctx, error, null);
  ctx.created = Date.now();
  CANCEL.reqId = req.id;
  logLine(`stop ${req.id} turn ${delivery} wait=${req.wait_s}s presence=${p.source}:${p.state}`);
  const settled = () => {
    if (mtimeOf(MARK.stop(ctx.s8)) > mine) return 'superseded';
    if (mtimeOf(MARK.prompt(ctx.s8)) >= ctx.started) return 'answered_on_computer';
    return terminalCheck(ctx);
  };
  const res = await waitAnswer(c, ctx, req, settled, null);
  return finish(
    c,
    ctx,
    req,
    res,
    (answer) => {
      const text = typeof answer.text === 'string' ? answer.text.trim() : '';
      return text ? { stderr: `The user replied from their phone: ${text}`, code: 2 } : null;
    },
    false,
  );
}

async function hookStopFailure(input, c) {
  const ctx = context(input, c, 'stop-failure');
  if (ctx.presence.state === 'present') return null;
  const err = input.last_assistant_message || (isObject(input.error) ? input.error.message : input.error) || 'Claude Code stopped on an API error.';
  const r = await http('POST', `${apiBase(c)}/v1/send`, {
    token: c.token,
    body: { id: `cc-err-${ctx.s8}-${Math.floor(Date.now() / 1000)}`, type: 'failed', agent: ctx.agentLabel, title: `Stopped on an error · ${ctx.project}`, body: clip(String(err), 200) },
    timeoutMs: 8000,
  });
  logLine(`stop-failure sent (${r.status})`);
  return r.status === 401 ? unpairedNotice() : null;
}

// --- session events (contract v2 § 2.2): they drive the session card on the iPhone lock screen.
// Nothing in claude -p, nothing when not paired; errors are ignored (async hooks, 5 s at most, no retry).

const cardFile = (s8) => markerPath(`${s8}.card`);
function saveCard(s8, st) {
  try {
    fs.mkdirSync(P.runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(cardFile(s8), JSON.stringify(st));
  } catch {
    // the next event checks -p again and may send one more tool event
  }
}

// A command line can carry a secret: it goes to the lock screen with the value hidden.
const maskSecrets = (line) =>
  line
    .replace(/\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|AUTH)[A-Za-z0-9_]*=)("[^"]*"|'[^']*'|\S+)/gi, '$1•••')
    .replace(/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+\/=-]{8,}/gi, '$1 •••')
    .replace(/^(\s*(?:mysql|mysqldump|mysqladmin|mariadb)\b.*?\s-p)\S+/, '$1•••')
    .replace(/(\/\/[^\s:@\/]+:)[^\s@\/]+@/g, '$1•••@');

// File name without its folder, host of the URL, first line of the command (secrets hidden); nothing else.
function toolTarget(ti) {
  if (typeof ti.command === 'string' && ti.command.trim()) return clip(maskSecrets(ti.command.trim().split('\n')[0]), 80);
  if (typeof ti.url === 'string') {
    try {
      return clip(new URL(ti.url).hostname.toLowerCase(), 80) || null;
    } catch {
      return null;
    }
  }
  const file = ti.notebook_path || ti.file_path;
  return typeof file === 'string' && file ? clip(path.basename(file), 80) : null;
}

async function sessionEvent(c, input, event, extra = {}) {
  if (!input.session_id) return;
  const s8 = session8(input);
  const st = readJSON(cardFile(s8)) || {};
  if (st.ppid !== process.ppid || typeof st.scripted !== 'boolean') Object.assign(st, { ppid: process.ppid, scripted: printMode(process.ppid) });
  const now = Date.now();
  if (st.scripted) return saveCard(s8, st);
  if (event === 'tool') {
    if (st.tool_at && now - st.tool_at < TOOL_EVENT_S * 1000) return saveCard(s8, st);
    st.tool_at = now;
  } else st.tool_at = 0; // the first tool after a prompt or a turn end goes at once: it changes the card's state
  st.sent = true;
  saveCard(s8, st);
  const meta = readJSON(markerPath(`${s8}.session.json`)) || {};
  const title = typeof input.session_title === 'string' && input.session_title ? input.session_title : meta.title;
  const body = { event, project: projectOf(input), project_id: projectIdOf(input), title: title ? clip(title, 60) : null, tool: null, message: null, ...extra };
  const r = await http('POST', `${apiBase(c)}/v1/sessions/${s8}/events`, { token: c.token, body, timeoutMs: 5000 });
  logLine(`session ${s8} ${event} ${r.status} ${r.data.state || r.data.error || r.data.message || ''}${r.data.card ? ` card=${r.data.card}` : ''}`);
}

async function hookPreToolUse(input, c) {
  const ti = isObject(input.tool_input) ? input.tool_input : {};
  const name = String(input.tool_name || '');
  if (!name) return;
  await sessionEvent(c, input, 'tool', { tool: { name: clip(name, 80), target: toolTarget(ti) } });
}

// SessionEnd has 1.5 s for every hook: send only for a session that had events, never wait long.
async function hookSessionEnd(input, c) {
  const s8 = session8(input);
  const st = readJSON(cardFile(s8));
  if (!isObject(st) || !st.sent || st.scripted) return;
  try {
    fs.unlinkSync(cardFile(s8));
  } catch {
    // already swept
  }
  const r = await http('POST', `${apiBase(c)}/v1/sessions/${s8}/events`, {
    token: c.token,
    body: { event: 'end', project: projectOf(input), project_id: projectIdOf(input), title: null, tool: null, message: null },
    timeoutMs: 1200,
  });
  logLine(`session ${s8} end ${r.status} ${r.data.state || r.data.error || r.data.message || ''}`);
}

function hookPostToolUse(input) {
  touch(MARK.post(session8(input), agentOf(input), fingerprint(input.tool_input)));
  sweepRun();
}

async function hookUserPrompt(input, c) {
  const prompt = typeof input.prompt === 'string' ? input.prompt : '';
  if (prompt.trimStart().startsWith('<task-notification>')) return; // background work reporting, not the user
  const s8 = session8(input);
  touch(MARK.prompt(s8));
  const file = markerPath(`${s8}.session.json`);
  const before = readJSON(file) || {};
  const title = typeof input.session_title === 'string' && input.session_title ? input.session_title : before.title || null;
  try {
    fs.writeFileSync(file, JSON.stringify({ prompt_at: Date.now(), title }));
  } catch {
    // duration and title are optional
  }
  sweepRun();
  if (c) await sessionEvent(c, input, 'prompt');
}

async function cmdHook(event) {
  let result = null;
  try {
    installSignalHandlers();
    let input = {};
    try {
      const raw = await readStdin();
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      input = {};
    }
    if (!isObject(input)) input = {};
    process.stdin.pause();
    if (event === 'post-tool-use') hookPostToolUse(input);
    else {
      const c = readComputer();
      if (c) claudeHeader = c.claude_version || null;
      if (event === 'user-prompt-submit') await hookUserPrompt(input, c);
      else if (c) {
        if (event === 'pre-tool-use') await hookPreToolUse(input, c);
        else if (event === 'session-end') await hookSessionEnd(input, c);
        else if (event === 'permission-request') result = await hookPermission(input, c);
        else if (event === 'elicitation') result = await hookElicitation(input, c);
        else if (event === 'stop') result = await hookStop(input, c);
        else if (event === 'stop-failure') result = await hookStopFailure(input, c);
      }
    }
  } catch (e) {
    logLine(`${event} error ${e && e.message}`);
    result = null;
  }
  const done = (code) => process.exit(code);
  if (result && result.stderr) return process.stderr.write(`${result.stderr}\n`, () => done(result.code || 0));
  if (result && result.stdout) return process.stdout.write(JSON.stringify(result.stdout), () => done(0));
  return done(0);
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

const HELP = `Monish ${VERSION}: Claude Code and your other agents on your iPhone lock screen. https://monish.cc

Claude Code
  npx monish pair <code>      pair this computer with the 6-digit code shown in the Monish app and add
                              the Claude Code hooks: permissions, questions, plans and the end of each
                              turn reach your iPhone, you answer from there (Allow, Allow for this
                              session, Always allow, Deny), and each session gets a lock screen card
  npx monish status           check the pairing, the answer window, the always-allowed rules, the hooks
                              and Claude Code
  npx monish test             send a test permission request to your iPhone (nothing is run)
  npx monish uninstall        remove the hooks and unpair this computer (--all: also the key, the skill
                              and the Codex and Cursor rules)

Other agents and scripts
  npx monish setup [--key an_XXXXXXXXXX]   save the key, install the Claude Code skill and hook,
                                           offer Codex and Cursor, send the "Connected" ping
  npx monish ping "message"                send one line to your iPhone

Pair options
  --name "MacBook Pro"   name shown on the iPhone (default: this computer's name)
  --api <url>            another Monish server, for development (default: https://monish.cc)
  --replace              pair again even if this computer is already paired (with another iPhone,
                         say): its always-allowed rules are removed. Without it, running pair on a
                         paired computer only updates the hooks and keeps the rules

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
  if (command === 'hook') return cmdHook(rest[0]);
  const { flags, args } = parseArgs(rest);
  if (command === '-v' || command === '--version' || flags.version) return say(VERSION);
  if (!command || command === '-h' || command === '--help' || command === 'help' || flags.help) return say(HELP);
  if (command === 'setup') return cmdSetup(flags);
  if (command === 'ping') return cmdPing(args, flags);
  if (command === 'pair') return cmdPair(args, flags);
  if (command === 'status') return cmdStatus();
  if (command === 'test') return cmdTest();
  if (command === 'uninstall') return cmdUninstall(flags);
  fail(`Unknown command "${command}".\n\n${HELP}`);
}

main()
  .then(() => {
    if (rl) rl.close();
    if (process.argv[2] !== 'hook') process.exit(process.exitCode || 0);
  })
  .catch((e) => fail(`monish: ${e.message}`));
