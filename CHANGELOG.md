# Changelog

All notable changes to OpenFox Telegram Bridge. Versions follow the `version` field of `package.json`.

## 1.0.6 — 2026-10-16

### Added
- `/criteria`: the session's acceptance criteria with their state, and ➕ Add to add criteria (one per line).
- 🤖 Add the proposed criteria (under `/criteria`): runs OpenFox's "Add criteria" command, as the web UI's commands menu does; the agent adds the criteria it proposed, then the build buttons follow.
- ✖ Cancel under the criteria, the build offer and the steps menu: removes the buttons, the criteria stay. A tapped button goes away too, and a new list removes the expired buttons of the previous one.
- Build buttons, as in the web UI: while criteria are pending, one ▶ button per workflow (▶ Build & Verify), shown under `/criteria` and at the end of a turn; ⋮ starts a single step. Workflows with parameters stay on the web UI.
- A workflow started from Telegram is followed through all its steps until it ends. `⏹ stop` stops it.
- The end of a workflow shows OpenFox's summary, as the web UI's card (iterations, time, tool calls, tokens, speed), with the criteria counted by state; also in follow mode. The list itself stays under `/criteria`.
- A workflow paused on a step that waits for the user (e.g. "Where to work") shows its choices as buttons; a choice resumes it.

### Fixed
- Follow mode: Telegram shows "typing…" while a turn started from OpenFox runs, reasoning included, until the turn ends, waits for an answer or fails. It used to show only for turns started from Telegram. It also shows at once when following a session whose turn is already running.
- A silent turn (a long command, a slow first token) no longer "expires": after 5 minutes without any event, the plugin asks OpenFox whether the turn still runs and keeps waiting (and showing "typing…") while it does. It gives up only when OpenFox says the turn is over or cannot be reached.
- The agent's reasoning and a command's output count as activity, without their content: neither ever reaches Telegram.
- Only the active session's events reach Telegram. OpenFox sends every session's events to each connection, and the plugin forwarded them all: with two sessions working at once, the other one's messages could show up.

## 1.0.5 — 2026-10-13

### Added
- `/model`: switch the session's model from Telegram. Providers are listed by name with their model count, the session's provider and model are marked with ✓, models come 10 per page with ◀️ ▶️, and typing a word filters the open list. A local model file is shown by its file name.
- Creating a session (button or `/new_session <title>`) asks for its model, with "default model" and "cancel" buttons.
- `/status` shows the session's model ("default model" when it has none of its own).

### Fixed
- A question that OpenFox no longer has (answered from the web UI, turn over, restart) no longer swallows every message with "404 No pending question": it is dropped, a typed message goes to the agent as a normal message, a tapped button says the question expired.
- In follow mode, the questions of an OpenFox turn are forgotten when that turn ends.
- The buttons of a choice or yes/no question are removed however the question is settled: typed custom answer, question gone on OpenFox, end of the turn (not only when a button is tapped).

## 1.0.4 — 2026-10-10

### Changed
- The blanket button of a permission request is named "Allow everything" (as in the web UI). It switches the session to dangerous mode, is not offered for `git --no-verify`, and allows the request once if the switch fails.
- Permission requests say what is asked, like the web UI: sensitive file, sensitive file outside the project, dangerous command, `git --no-verify`, outside the project.
- Routine confirmation and turn bookkeeping is logged at debug level.

### Fixed
- With a message sent during a turn, an auto-compaction no longer ends the turn before the answer to that message.
- A permission click removes the buttons once (the second removal failed and was logged as an error).

## 1.0.3 — 2026-10-09

### Fixed
- Reloading the plugin (enable/disable, update) stops the previous instance. A leftover instance kept polling Telegram and answers could be forwarded several times.

## 1.0.2 — 2026-10-09

### Fixed
- The buttons of a permission request are removed when the turn ends without an answer, also for turns followed from the web UI.

## 1.0.1 — 2026-10-09

### Changed
- "Always allow" on a permission request switches the session to dangerous mode, so the following requests of the session are approved too.

### Fixed
- An auto-compaction no longer ends the turn early: the agent's real answer after the compaction is forwarded, the compaction summary is not.
- A turn ending with a workflow step (`step_done`) ends here too, so the typing indicator stops.
- A failure to switch the danger level is reported instead of being silent.
- Missing translations.

## 1.0.0 — 2026-10-08

First public release.

- Pick a project and a session, create projects and sessions, send tasks to the agent; the active session is kept across restarts.
- Reply keyboard (start, stop, agents, status) and a `/` command menu in French and English; only start without an active session.
- The agent's messages are forwarded as they come, formatted (bold, code, lists, links); answers longer than 7,000 characters come as a `reponse.md` file.
- One progress message per turn lists the tools the agent runs, long commands folded in an expandable quote; the files a turn changed are summed up at its end.
- Messages sent while the agent works go to OpenFox's queue at once.
- The agent's questions (buttons or a typed answer) and permission requests (Allow / Deny / Always allow) can be answered from Telegram.
- Stop the agent, switch between builder and planner, toggle night mode, see the session status.
- Photos and files (images, PDFs, text and code, up to 20 MB) are sent to the session as attachments.
- Optional follow mode: turns started from the web UI reach Telegram too.
- Only the authorized Telegram user ID can use the bot; without one, it answers nobody.
- Status panel from the plugin's row in OpenFox's plugins menu.
- The plugin finds the port of the OpenFox it runs in; settings apply without a restart, except the bot token.
