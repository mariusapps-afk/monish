---
name: monish
description: Send progress, results, failures, questions and numbers from this agent to the user's iPhone (Monish app). Use when a task runs longer than a minute, finishes, fails, needs a human decision, or produces a figure worth seeing on a phone.
---

# Monish — notify the user's iPhone

Served at `https://monish.cc/skill/<key>` (also at `/skill`). Read it once, then follow it for the rest of the session. Everything goes through one endpoint; there is no account, no SDK and nothing to install besides `curl`.

## 1. Set up (first time only)

The user pasted a line like:

```
Set up my agent notifications with key an_7Q2k9fXbRm — follow https://monish.cc/skill/an_7Q2k9fXbRm
```

1. Take the key: the token starting with `an_` (13 characters, letters and digits).
2. Save it so future sessions find it without asking:

```bash
mkdir -p ~/.config/monish && printf '%s' 'an_7Q2k9fXbRm' > ~/.config/monish/key && chmod 600 ~/.config/monish/key
```

3. From now on, resolve the key in this order: `$MONISH_KEY` environment variable, then `~/.config/monish/key`. Never print the key back to the user and never write it into a repository.
3b. Install this file as a local skill so future sessions know when to reach the phone without being told (Claude Code reads the `description` above to decide when to load it):

```bash
mkdir -p ~/.claude/skills/monish && curl -s https://monish.cc/skill -o ~/.claude/skills/monish/SKILL.md
```

Codex and Cursor have no skills folder: see section 4 for the one line to add to the project rules instead.
4. Send the connection ping. The app is waiting for it to finish onboarding:

```bash
curl -s https://monish.cc/v1/send -H 'content-type: application/json' -d "{
  \"key\":\"$(cat ~/.config/monish/key)\",\"id\":\"setup-$(date +%s)\",\"type\":\"done\",\"agent\":\"$AGENT_NAME\",
  \"title\":\"Connected\",\"body\":\"Your agent can now reach this iPhone.\"}"
```

`$AGENT_NAME` is a short label the user will see on every item, for example `Claude Code · harbor` or `Codex · lumen`: the tool, a dot, the project. Keep it under 40 characters.

Keep the `setup-` id: it tells the app this is the connection ping. The app marks your agent as connected and shows it by name; it never lists this ping in the feed. Never use the `setup-` prefix for anything else.

5. Tell the user in one line that the ping is sent and that they can continue in the app. If the request returned `401 unknown_key`, the app has not registered yet: ask the user to finish the notifications step in the app, then retry once.

6. Install the hook (section 4) so the phone rings when you are stuck on a permission prompt.

## 2. The one endpoint

```
POST https://monish.cc/v1/send
```

JSON body, 4 KB max:

| Field | Required | Meaning |
|---|---|---|
| `key` | yes | The user's key (or send it as `Authorization: Bearer an_…`) |
| `type` | yes | `progress`, `done`, `failed`, `ask` or `metrics` |
| `title` | yes | ≤ 60 characters in the feed. For an `ask`, the whole question (≤ 200) is kept and shown on the notification and the lock-screen card; for other types a longer title is cut and its full text goes into `body` when `body` is empty |
| `body` | no | ≤ 200 characters. The detail |
| `agent` | no | Your label, ≤ 40 characters |
| `id` | no | Reuse the same `id` to update an item instead of adding a new one |
| `fields` | depends | Typed data for the layout, see section 3 |
| `template` | no | Layout override: `progress`, `steps`, `approval`, `status`, `timer`, `value`, `metrics`, `log` |
| `expires_in` | `ask` only | Seconds before the question expires, 300 to 86400, default 3600 |
| `quiet` | no | `true` for a silent update (no sound, no banner) |
| `url` | no | Link opened on tap |
| `actions` | no | Up to 2 buttons shown on the live card, e.g. `[{"id":"stop","label":"Stop"}]`. Poll `/answer/<id>` to learn which one was tapped (`status` = the action `id`) |
| `live` | no | `metrics` only: `true` keeps the numbers as a live card on the lock screen, updated each time you resend the same `id` (8 hours max) |

Response `202 {"id":"…","status":"queued"}`.

A small helper you can define once per session:

```bash
notify() { curl -s https://monish.cc/v1/send -H 'content-type: application/json' \
  -H "authorization: Bearer ${MONISH_KEY:-$(cat ~/.config/monish/key)}" -d "$1" >/dev/null; }
```

## 3. Which type, when

Pick the first rule that matches.

| Situation | `type` | What the user sees |
|---|---|---|
| You need a yes or no before continuing | `ask` | A question with Approve / Deny on the lock screen; the item stays on top until answered |
| Something finished well | `done` | A green line with the result |
| Something broke and you stopped | `failed` | A red line, delivered even in quiet hours |
| A task will take more than a minute and has a measurable progress | `progress` | A live card on the lock screen that updates in place |
| You produced numbers worth reading (report, totals, KPIs) | `metrics` | A violet line with 2 to 4 figures. Add `live: true` and reuse the `id` to keep them live on the lock screen (one figure → a big number, 2 to 4 → columns) |

Rules that keep it useful:

- One `id` per task. Send `progress` with it, then `done` or `failed` with the same `id`. The user sees one line that changes colour, not three.
- Resending the same `id` with the same title, body and fields is delivered silently: the line moves up, the phone does not ring again. A blocker that is still there every 30 minutes does not need 14 rings. To ring again, say what changed.
- Many things at once (an inbox, a batch of files, a list of alerts): one item, not one push per element. Use `template: log` with up to 4 lines and a `url`, or one `done` with the count in `body`. 29 pushes in 4 minutes is unreadable on a lock screen.
- `progress` and `log` at most every 30 seconds, and only when the step or the value actually changed, with `quiet: true` unless the phase changed. Apple throttles live updates; too many and they stop arriving.
- Never send from inside a loop. Merge log lines into one item per 30 seconds; one `done` at the end beats twenty updates.
- Budget: 300 sends per hour per key, all types included, and at most 10 in 10 seconds. An agent that follows the cadence above never gets close. Past the limit the server answers `429` with `retry_after`; wait that long, drop the pending `progress` updates, and send only the next `done`, `failed` or `ask`.
- A long `progress` deserves a `Stop` action: send `actions: [{"id":"stop","label":"Stop"}]` and poll `/answer/<id>` in the background; `status: "stop"` means stop that task and send a `done` saying so.
- `title` says what, `body` says how much or where. No markdown, no emoji, no capitals.
- Never put secrets, tokens or full file contents in an item.
- Do not send `done` for trivial steps. The user wants results, not a log of every command.

### `fields` cheat sheet

```jsonc
// progress
{"value":0.86,"done":12,"total":14,"unit":"tests","detail":"test_auth.py"}
// progress + "template":"steps"
{"current":3,"steps":[{"label":"lint","state":"done"},{"label":"build","state":"active"},{"label":"test","state":"pending"}]}
// failed
{"message":"cannot find type Entitlement","severity":"error","code":"exit 65"}
// ask (fields optional: title is used as the question)
{"question":"Send the 50% offer to 212 users?","context":"≈ $0.40 · Resend","risk":"high"}
// metrics
{"items":[{"label":"revenue","value":"$1,240"},{"label":"trials","value":"12"},{"label":"refunds","value":"3"}]}
```

## 4. One hook, for the one moment you cannot speak

The skill (section 3) is how you decide *what* and *when* to send: a finished task, a failure, a figure, a question. Do not add a hook for those; a hook cannot write a useful title and only duplicates what you send yourself. The single exception is when Claude Code stops and waits for the user's permission: you cannot send anything from inside that pause, so a hook does it for you.

### Claude Code

Add to `~/.claude/settings.json` (merge with existing `hooks`). `Notification` fires for several events; only `permission_prompt` and `elicitation_dialog` mean Claude is stuck, so the script below drops the others (`auth_success`, `idle_prompt`: one user received 58 « Needs you » for sign-ins alone). It is sent as a warning with sound, because the task is stuck until the user comes back; the phone's quiet hours still apply at night.

```json
{
  "hooks": {
    "Notification": [{"hooks":[{"type":"command","command":"~/.config/monish/hook.sh"}]}]
  }
}
```

Write `~/.config/monish/hook.sh` (make it executable):

```bash
#!/bin/sh
# Monish: ping the phone when Claude Code waits for the user. Reads the hook JSON on stdin.
key="${MONISH_KEY:-$(cat ~/.config/monish/key 2>/dev/null)}"; [ -z "$key" ] && exit 0
input=$(cat)
kind=$(printf '%s' "$input" | jq -r '.notification_type // ""' 2>/dev/null)
case "$kind" in permission_prompt|elicitation_dialog) ;; *) exit 0 ;; esac
project=$(basename "$PWD")
body=$(printf '%s' "$input" | jq -r '.message // ""' 2>/dev/null | head -c 200)
jq -nc --arg k "$key" --arg t "Needs you · $project" --arg b "$body" --arg a "Claude Code · $project" \
  '{key:$k,type:"done",title:$t,body:$b,agent:$a,fields:{severity:"warning"}}' \
  | curl -s -m 5 https://monish.cc/v1/send -H 'content-type: application/json' -d @- >/dev/null
exit 0
```

The hook must always exit 0 and never block: a 5 second timeout, no retries. Do not add a `Stop` hook: a "turn finished" line with no content is noise, and the real result belongs to the `done` you send from section 3.

### Codex and Cursor

They have no equivalent hook. Instead, add this to the project's `AGENTS.md` (Codex) or `.cursor/rules` (Cursor):

```
When a task longer than a minute finishes, fails, or needs my decision, call the Monish endpoint as described in https://monish.cc/skill with the key in ~/.config/monish/key. One item per task, same id for progress then done.
```

Then call `notify` yourself at those moments.

If you wire Codex's `notify` setting to Monish, send its approval events with a fixed `id` per project (`codex-<project>`) and `type: done`, `fields: {"severity":"warning"}`: repeated approvals update one line instead of stacking, and identical repeats arrive silently. Do not relay every assistant turn: the real result belongs to the `done` you send yourself.

### Cron, CI, shell scripts

Export `MONISH_KEY` in the environment and call `curl` directly. One `failed` on non-zero exit, one `done` with the figures otherwise.

## 5. Asking a question and waiting

Send `type: ask`, then poll the answer. Each call blocks up to 25 seconds and returns `pending` until the user taps.

```bash
id="deploy-$(date +%s)"
notify "{\"key\":\"$key\",\"id\":\"$id\",\"type\":\"ask\",\"agent\":\"$AGENT_NAME\",
  \"title\":\"Deploy 1.6 to production?\",\"body\":\"3 commits · tests green\",\"expires_in\":900}"

while :; do
  s=$(curl -s "https://monish.cc/v1/answer/$id" -H "authorization: Bearer $key" | jq -r .status)
  case "$s" in pending) continue ;; *) break ;; esac
done
# s is approved | denied | expired | text  (or an action id, e.g. stop, for items sent with actions)
# if s is text, read the free-form reply:
#   curl -s "https://monish.cc/v1/answer/$id" -H "authorization: Bearer $key" | jq -r .text
```

- `approved`: continue. `denied` or `expired`: stop that step, say so, and do not retry the same question. An expired question is a no.
- `text`: the user typed a reply in the app (up to 500 characters) instead of tapping. Read it as an instruction that replaces or qualifies the question (« yes but 30 % », « not now, after the release »), act on it, and confirm with a `done`.
- Use `ask` only for decisions the user would want to make: spending money, deploying, sending to real people, deleting. Not for « shall I continue? ».
- An `ask` is a yes or no. An open question (« which cleanup steps should I run? ») is not one: send it as `done` with the choices in `body` and continue when the user answers in your chat, or make it a real choice between two labelled options with `fields.approve_label` / `deny_label` (≤ 24 characters each).
- Put the whole question in `title` (up to 200 characters, kept in full for an `ask`); `body` carries the stakes or the options, never the question itself.
- Rate it with `fields.risk`: `low` (easy to undo), `medium` (reversible but visible or costly, such as a deploy or a paid run: check the details first) or `high` (cannot be undone: real people, money, deletion); any other value is ignored.
- Set `expires_in` to how long the decision stays relevant. Default is one hour; never under 15 minutes unless you block on the answer right now, the user may be away from the phone. The server floors it at 5 minutes.
- Keep working on independent things while waiting; only the dependent step blocks.

## 6. Errors

| Response | Do |
|---|---|
| `401 unknown_key` | The key was reset or never registered. Ask the user to paste the line from the app again. |
| `429 rate_limited` | You sent more than 300 items this hour or 10 in 10 seconds. Wait `retry_after` seconds, drop the queued `progress` updates, keep only the next `done`, `failed` or `ask`. |
| `413 too_large` | Shorten `body` and `fields`. |
| `400 schema` | Fix the body; the message names the field. |
| network error or 5xx | Retry once after 5 seconds, then carry on with the task. A missed notification is never a reason to stop working. |
