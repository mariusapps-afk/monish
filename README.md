# Monish

Monish puts what your coding agent does on your iPhone lock screen: results, failures, live progress, and yes or no questions you answer with Approve or Deny without unlocking.

![A question from the agent on the iPhone lock screen with Approve and Deny](assets/lockscreen.png)

## Requirements

- An iPhone on iOS 17.2 or later, with [Monish from the App Store](https://apps.apple.com/app/apple-store/id6822071271?pt=128786655&ct=github&mt=8).
- For Claude Code: nothing else, the installer below brings the `monish` command (macOS, Linux, Windows). Node 18 or later only if you prefer `npx monish`.
- For `npx monish setup` (other agents): Node 18 or later, and `jq` for the hook. It ships with macOS 15 and later; otherwise `brew install jq` or `apt install jq`.

## Install

1. Get [Monish on the App Store](https://apps.apple.com/app/apple-store/id6822071271?pt=128786655&ct=github&mt=8). It is free, with no account. During onboarding it gives you a setup line that contains your key (`an_…`).
2. In a terminal:

```bash
claude plugin marketplace add mariusapps-afk/monish
claude plugin install monish@monish
npx monish setup
```

`npx monish setup` asks for that line or the key alone, saves the key, offers to add the Monish rule for Codex and Cursor, and sends the "Connected" ping that finishes onboarding in the app. On Codex, Cursor, or Claude Code without plugins, `npx monish setup` alone is enough: it also installs the skill and the hook.

## Claude Code: install and pair

Open Monish on your iPhone: it shows a 6-digit code. Then, in a terminal on the computer:

```bash
curl -fsSL https://monish.cc/install.sh | sh -s 482913                # macOS and Linux
```

```powershell
irm https://monish.cc/install.ps1 | iex; monish pair 482913            # Windows PowerShell
```

```bash
npx monish pair 482913                                                 # anywhere, with Node 18 or later
```

The installer needs no Node and no sudo. It downloads the `monish` program for your system from the [latest release](https://github.com/mariusapps-afk/monish/releases/latest), checks its SHA-256, puts it in `~/.local/bin/monish` (`%USERPROFILE%\.local\bin\monish.exe` on Windows), adds that folder to your `PATH` if needed (one line in `~/.zshrc`, `~/.bashrc`, `~/.bash_profile` or fish's `config.fish`; the user `Path` on Windows), then runs `monish pair` with the code. Run it again to update: on a computer that is already paired, `pair` leaves the code unused, keeps the pairing and its always-allowed rules, and only rewrites the hooks (`monish pair <code> --replace` pairs anew, with another iPhone for example, and removes those rules). Options, as environment variables: `MONISH_INSTALL_DIR` (another folder), `MONISH_VERSION` (a given release, e.g. `1.2.0`), `MONISH_NO_MODIFY_PATH=1`. Extra arguments go to `pair`: `sh -s 482913 --name "MacBook Pro"`.

## Claude Code commands

```bash
monish pair 482913        # the 6-digit code shown in the Monish app; --name "MacBook Pro" to rename this computer
monish status             # pairing, iPhone app version, answer window, always-allowed rules, hooks, Claude Code version
monish test               # sends a test permission request to your iPhone; nothing is run
monish uninstall          # removes the hooks and unpairs this computer
monish uninstall --all    # also removes the key, the skill and the Codex and Cursor rules
```

With Node, the same commands work as `npx monish …`.

`pair` points the hooks at the installed `monish` program (with `npx`, it copies the tool to `~/.config/monish/monish.js` and the hooks run it with Node), saves this computer's token in `~/.config/monish/computer.json` (readable by you only) and adds eight hooks to `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`, or the file it links to): `PermissionRequest`, `Elicitation`, `Stop`, `StopFailure`, `PostToolUse`, `UserPromptSubmit`, `PreToolUse` and `SessionEnd`. Your other hooks are kept and the previous file is saved as `settings.json.monish-backup`; `uninstall` removes exactly what `pair` added.

From then on, Claude Code's permission prompts, plans, questions, MCP forms and the end of each turn reach your iPhone, and the first answer wins: on the iPhone or in the terminal. While you type in Claude's terminal, your iPhone only gets a silent note, and a request the terminal answered is closed on the iPhone. If you reply to the end of a turn, Claude takes the reply as its next instruction. How long a request waits for the iPhone is the answer window you set in Monish (10 minutes by default).

A permission with a clear target can be answered with **Allow for this session** or **Always allow this command** (or this site, this tool, edits in this project). The rule is kept by Monish, not in your Claude Code settings: it covers that exact command (site, tool) in that project folder on this computer, the next time Claude Code asks it is allowed without reaching your iPhone, and removing it in Monish (Setup, Computers) takes effect at the next request. Session rules end with the session. No rule is offered for edits to config files that decide what runs or what is allowed (anything under `.claude/`, `.git/`, `.vscode/`, `.idea/`, `.husky/`, and `.mcp.json`, `.envrc`), for read-only tools (`Read`, `Grep`, `Glob`, `LS`), for a command run outside the sandbox, nor for anything when Claude Code runs in your home folder or a disk root: those are always asked. With another `PermissionRequest` hook installed, a rule waits 10 seconds like a request, so that hook's deny wins. Each interactive session also gets one card on the lock screen that follows it (working, needs you, question, plan, done); `claude -p` runs get none. The hooks send what the request shows (the command and its description, the file path, the plan, the questions, the form or the end-of-turn message), the project folder name, a short hash of the project path and of the session id, and this computer's name to `https://monish.cc`; for the session card, the name of the tool being run with the file name, the site or the first line of the command, at most every 15 seconds, and the start of the end-of-turn message (values that look like keys, tokens or passwords in that first line are hidden). macOS and Linux, Windows in beta. To remove the program itself after `monish uninstall`: delete `~/.local/bin/monish` and the line marked `# added by monish` in your shell startup file.

## What you get

- **A ping when Claude Code is stuck.** When Claude Code stops for your permission or for an MCP form, your phone rings with the project name and what it is waiting for. One line per project, updated in place, so a task blocked for an hour does not ring twenty times.
- **The `monish` skill.** Claude decides when a finished task, a failure, a long-running progress bar (a Live Activity on the lock screen), a few figures, or a question deserves your phone. Questions come with Approve and Deny buttons on the lock screen, and Claude reads your answer.
- **Any agent, any script.** It is one HTTPS endpoint, so Codex, Cursor, cron jobs, CI and n8n can use it with `curl`. The full contract is at [monish.cc/skill](https://monish.cc/skill).

```bash
npx monish ping "Backup finished" --body "214 files, 3.2 GB"
```

## What it runs and sends

- **Hook** (`hooks/notify.sh`): runs on Claude Code `Notification` events, keeps only `permission_prompt` and `elicitation_dialog`, and posts the notification text, the project folder name and your key to `https://monish.cc/v1/send`. It needs `jq` and `curl`, times out after 5 seconds, always exits 0, and does nothing when no key is saved.
- **Skill** (`skills/monish/SKILL.md`): instructions that tell Claude when and how to call the same endpoint with `curl`.
- **CLI** (`npx monish setup`): writes your key to `~/.config/monish/key` (readable by you only), downloads the skill from `https://monish.cc/skill` to `~/.claude/skills/monish/SKILL.md`, writes `~/.config/monish/hook.sh` and adds one `Notification` hook to `~/.claude/settings.json` or the file it links to (existing hooks are kept, the previous file is saved as `settings.json.monish-backup`), adds one rule to `~/.codex/AGENTS.md` or `.cursor/rules/monish.mdc` only if you say yes, then sends one ping. When the plugin is enabled, the CLI skips the skill and the hook. No dependencies, no telemetry.

## Uninstall

1. Remove the plugin: `claude plugin uninstall monish@monish`, then `claude plugin marketplace remove monish`.
2. Remove what `npx monish setup` wrote, the key and the hook script included:

```bash
rm -rf ~/.config/monish ~/.claude/skills/monish ~/.claude/settings.json.monish-backup
```

3. In `~/.claude/settings.json`, delete the `Notification` entry whose command is `~/.config/monish/hook.sh`. If you added the Monish rule, delete it from `~/.codex/AGENTS.md` or `.cursor/rules/monish.mdc`.

## Privacy

There is no account. Your key stays on your machine and in the app. What your agents send is kept 48 hours on our server, then deleted; answers are kept 24 hours. The only exception is what you choose to always allow (a command, a site, a tool name): it is kept until you remove it in the app, unpair the computer or delete your key. Details in the [privacy policy](https://monish.cc/privacy).

## Links

- [Monish on the App Store](https://apps.apple.com/app/apple-store/id6822071271?pt=128786655&ct=github&mt=8)
- [monish.cc](https://monish.cc)
- [API and rules for agents](https://monish.cc/skill)
- [Claude Code notifications on iPhone](https://monish.cc/claude-code-notifications-iphone)
- [Codex notifications on iPhone](https://monish.cc/codex-notifications)
- [Approve from the lock screen](https://monish.cc/approve-from-lock-screen)
- [n8n and scripts to iPhone](https://monish.cc/n8n-iphone-notifications)
- [Monish vs Pushary vs Agentfy vs ntfy](https://monish.cc/compare)
- [Support](https://monish.cc/support)

## Release of the standalone program (maintainers)

`sh install/build.sh` builds `dist/monish-<os>-<arch>.gz` (darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64) and `dist/SHA256SUMS` with [Bun](https://bun.sh), signing the macOS builds ad hoc. `sh install/release.sh` builds them again from a clean, pushed commit and publishes them as the GitHub release `v<version of package.json>`, which `install.sh` and `install.ps1` download. `MONISH_DOWNLOAD_URL` points both installers at another folder (a local server, for tests) and `MONISH_API` makes `install.sh` pair against another server. `monish.cc/install.sh` and `monish.cc/install.ps1` serve `install/install.sh` and `install/install.ps1`.

## License

[MIT](LICENSE), Marius Labs.
