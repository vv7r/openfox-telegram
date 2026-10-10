# OpenFox Telegram Bridge

Drive [OpenFox](https://github.com/co-l/openfox) from Telegram: pick a project and a session, send tasks to the agent, follow its work, answer its questions and permission requests, from your phone.

The plugin runs inside OpenFox and talks to the server it runs in. Plain ESM, no dependencies (Node 22+).

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy its token.
2. Get your Telegram user ID from [@userinfobot](https://t.me/userinfobot).
3. In OpenFox, open **Settings → Plugins**, install from `https://github.com/vv7r/openfox-telegram`, and enable it.
4. In the plugin settings, fill in the **bot token** and the **authorized user ID**, then disable and enable the plugin once to apply the token.
5. Send `/start` to your bot.

Only the authorized user can use the bot. Without an ID, it answers nobody.

## Using it

The keys under the input:

| Key | Does |
| --- | --- |
| ▶️ start | Lists the projects, then their sessions (closes the active session) |
| ⏹ stop | Stops the agent |
| 🤖 agents | Switches between builder and planner, toggles night mode |
| 📊 status | Project, session, agent, model, night mode, activity, context used |

Without an active session, only ▶️ start is shown. Typing `/` lists the commands, in French or English: the four keys, plus `/model` (switch the session's model: providers by name, 10 models per page, type a word to filter), `/sessions` (sessions of the project), `/new` (new project) and `/new_session` (new session).

A plain message goes to the active session. While the agent works:

- one progress message lists the tools it runs, long commands folded in an expandable quote;
- a message you send goes to OpenFox's queue at once, as in the web UI;
- questions come with buttons (or answer by message), permission requests with Allow / Deny / Allow everything (as in the web UI, it switches the session to dangerous mode; it is not offered for `git --no-verify`).

At the end of a turn:

- the answer is formatted (bold, code, lists, links); beyond 7,000 characters it comes as a `reponse.md` file;
- the files the agent changed are summed up: `📝 3 files changed (+45 −12)`, with the list.

Photos and files (images, PDFs, text and code files, up to 20 MB) are sent to the session as attachments, with their caption.

The active session is kept across restarts. Opening a session shows its last messages; a long one keeps its end.

In OpenFox, the plugin's row in the plugins menu opens a status panel: Telegram connection, bot name, authorized ID, and each chat's session and activity.

## Settings

| Setting | Default | |
| --- | --- | --- |
| Bot token | — | Required. Applied when the plugin restarts. |
| Authorized user ID | — | Required. Only this Telegram user drives the bot. |
| Follow sessions started from OpenFox | off | Answers, questions, permission requests and changed files of turns started from the web UI reach Telegram too. |
| OpenFox URL | automatic | The plugin finds the port of the OpenFox it runs in. Set it only for an unusual setup. Applied when the plugin restarts. |
| History message count | 6 | Messages shown when a session is opened. |
| Characters per history message | 500 | A longer message keeps its last characters. |

Settings other than the token and the URL apply at once.

## Development

```bash
npm test
```

## License

MIT
