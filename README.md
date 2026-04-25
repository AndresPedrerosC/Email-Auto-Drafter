# Email Auto-Drafter

A small Node daemon that polls Gmail, recognizes senders you've corresponded with before, and writes draft replies in your voice using an LLM. Drafts land in your Gmail Drafts folder for you to review and send.

## Features

- **Polls Gmail every 2 minutes** for new unread inbox messages
- **Two-pass LLM pipeline**: first updates a per-contact memory (name, relationship, tonality, notes), then drafts the reply with that memory and recent thread history as context
- **Persistent contact memory** in `.contacts.json` — improves over time
- **Voice-controlled prompting** via the embedded `EMAIL_COMPOSER_SKILL` system prompt (no em dashes, no filler, simple sign-offs, etc.)
- **Single-instance lock** prevents duplicate daemons from polling concurrently
- **End-to-end feedback loop** (`send-test.js`) for testing the pipeline without waiting for real email
- Backed by NVIDIA NIM by default (configurable model); any OpenAI-compatible endpoint also works

## Setup

### 1. Install

```bash
npm install
```

### 2. Get a Gmail API credentials file

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or pick a project
3. **APIs & Services → Library** → search **Gmail API** → Enable
4. **APIs & Services → Credentials** → **Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Desktop app**
6. Download the JSON and save it as `credentials.json` in the project root

### 3. Authorize Gmail

```bash
npm run auth
```

Opens a URL, you approve, paste the code back. Creates `token.json` locally.

### 4. Add your NVIDIA NIM API key

Create a `.env` file in the project root:

```
NVIDIA_API_KEY=nvapi-...
```

Get a key at [build.nvidia.com](https://build.nvidia.com/) (free tier available). Any OpenAI-compatible API works — see [Configuration](#configuration) to override the model or base URL.

### 5. Run

```bash
npm start
```

The daemon prints a heartbeat each poll cycle and a per-email log line as it works.

## Configuration

All knobs live in the `CONFIG` block at the top of [`index.js`](index.js) and can be overridden via environment variables.

| Variable                  | Default                  | Description                                                |
| ------------------------- | ------------------------ | ---------------------------------------------------------- |
| `NVIDIA_API_KEY`          | _(required)_             | API key for the NIM endpoint                               |
| `NVIDIA_MODEL`            | `moonshotai/kimi-k2.5`   | Chat model id                                              |
| `NIM_MEMORY_MAX_TOKENS`   | `8192`                   | Token budget for the contact-memory pass (cap 32768)       |
| `NIM_DRAFT_MAX_TOKENS`    | `8192`                   | Token budget for the draft pass (cap 32768)                |
| `NIM_TIMEOUT_MS`          | `1800000` (30 min)       | HTTP timeout per LLM call (reasoning models can be slow)   |
| `NIM_MAX_RETRIES`         | `5`                      | OpenAI SDK retry count on transient errors                 |

Hardcoded in `CONFIG` (edit the source if you want to change them):

| Key              | Default        | Description                                            |
| ---------------- | -------------- | ------------------------------------------------------ |
| `pollIntervalMs` | 120000 (2 min) | How often to check for new emails                      |
| `historyDepth`   | 5              | How many past emails from a sender to include as context |

## How it works

1. Every 2 minutes, fetches unread inbox emails (excluding your own outgoing mail)
2. **Known-contact gate**: a sender is "known" if they're a key in `.contacts.json` _or_ you've previously sent them an email. Unknown senders are skipped.
3. For known contacts, fetches up to 5 recent past emails from them for thread context
4. **Pass 1 (memory)**: the LLM reads the new email + history and emits a JSON contact-memory update (`name`, `relationship`, `tonality`, `notes`) — saved to `.contacts.json`
5. **Pass 2 (draft)**: the LLM writes a reply using the contact memory + the embedded voice/style skill
6. Saves the reply as a Gmail draft in the same thread
7. Tracks processed email IDs in `.state.json` so nothing is processed twice

## Feedback loop (testing end-to-end)

`send-test.js` sends one email from a secondary Gmail account to your primary one, so you can verify the full pipeline without waiting for real mail. It uses Gmail SMTP with an app password.

### 1. Enable 2-Step Verification on the secondary Gmail

Google only allows app passwords on 2FA-enabled accounts.

1. Sign in to the secondary Gmail at [myaccount.google.com](https://myaccount.google.com)
2. **Security → 2-Step Verification** → turn on

### 2. Generate an app password

1. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
2. Name it anything (e.g. `Email Composer Test`)
3. Copy the 16-character password (drop the spaces)

### 3. Add to `.env`

```
SENDER_EMAIL=your-secondary@gmail.com
SENDER_APP_PASSWORD=<16-char-password>
```

### 4. Run a test cycle

```bash
npm run send-test     # auto-seeds the sender into .contacts.json, sends one email
npm start             # processes the new email, generates a draft
```

After a poll cycle, verify:

- **Console** — clean run, no parse-failure warnings
- **`.contacts.json`** — the sender entry has `name`, `relationship`, `tonality`, `notes`
- **Gmail Drafts** — a reply exists in the test thread

`send-test.js` accepts `--subject "..."` and `--body "..."` to vary inputs across iterations.

## Run as a background service

### systemd (Linux)

```ini
[Unit]
Description=Email Auto-Drafter
After=network.target

[Service]
Type=simple
User=YOUR_USERNAME
WorkingDirectory=/path/to/email-drafter
ExecStart=/usr/bin/node /path/to/email-drafter/index.js
EnvironmentFile=/path/to/email-drafter/.env
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now email-drafter
sudo journalctl -u email-drafter -f   # tail logs
```

The single-instance lock means restarts are safe — a duplicate process refuses to start.

## Project layout

```
email-drafter/
├── index.js           # Main daemon (polling, LLM passes, draft creation, lock)
├── auth.js            # One-time Gmail OAuth setup
├── send-test.js       # Sends a test email from a secondary Gmail (feedback loop)
├── package.json
├── credentials.json   # Google OAuth client (you provide this)
├── token.json         # Created by `npm run auth` (keep private)
├── .env               # API keys + sender credentials
├── .contacts.json     # Per-contact memory (auto-managed)
├── .state.json        # Processed email IDs (auto-managed)
└── .daemon.lock       # PID lockfile, removed on graceful shutdown
```

## Privacy & security

`credentials.json`, `token.json`, `.env`, and `.contacts.json` give access to your Gmail and contain personal data. They are gitignored by default. Don't commit them.

If `.daemon.lock` is left behind after a crash, the next `npm start` detects the dead PID and removes it automatically.
