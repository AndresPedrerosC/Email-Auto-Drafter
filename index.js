#!/usr/bin/env node

/**
 * Email Auto-Drafter
 * Polls Gmail for new, unread inbox messages from known contacts and generates draft replies.
 * Runs as a daemon on your home server.
 */

import OpenAI from "openai";
import "dotenv/config";
import { google } from "googleapis";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function clampInt(raw, fallback, min, max) {
  const n = typeof raw === "string" ? Number.parseInt(raw, 10) : typeof raw === "number" ? raw : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// ─── Config ──────────────────────────────────────────────────────────────────

const CONFIG = {
  pollIntervalMs: 2 * 60 * 1000,      // Check every 2 minutes
  historyDepth: 5,                      // How many past emails from sender to include as context
  /** NVIDIA NIM chat model id (wrong id → HTTP 404 from integrate.api.nvidia.com) */
  nimChatModel: process.env.NVIDIA_MODEL || "moonshotai/kimi-k2.5",
  /**
   * Kimi reasoning uses many tokens before emitting visible `content`. Too low → empty/partial replies.
   * Override with NIM_MEMORY_MAX_TOKENS / NIM_DRAFT_MAX_TOKENS (defaults 8192 each; cap 32768).
   */
  nimMemoryMaxTokens: clampInt(process.env.NIM_MEMORY_MAX_TOKENS, 8192, 1, 32768),
  nimDraftMaxTokens: clampInt(process.env.NIM_DRAFT_MAX_TOKENS, 8192, 1, 32768),
  /** Long NIM reasoning runs often exceed the SDK default (10 min). Set NIM_TIMEOUT_MS if needed. */
  nimTimeoutMs: clampInt(process.env.NIM_TIMEOUT_MS, 1_800_000, 60_000, 7_200_000),
  nimMaxRetries: clampInt(process.env.NIM_MAX_RETRIES, 5, 0, 10),
  stateFile: path.join(__dirname, ".state.json"),
  contactsFile: path.join(__dirname, ".contacts.json"),
  credentialsFile: path.join(__dirname, "credentials.json"),
  tokenFile: path.join(__dirname, "token.json"),
  lockFile: path.join(__dirname, ".daemon.lock"),
};

// ─── Single-instance lock ────────────────────────────────────────────────────
// Prevents accidental duplicate daemons (e.g. after orphaned background runs)
// from polling Gmail concurrently and tripping NIM rate limits.

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = process exists but we lack permission to signal it (still alive)
    return err.code === "EPERM";
  }
}

function acquireLock() {
  if (fs.existsSync(CONFIG.lockFile)) {
    const existingPid = Number.parseInt(fs.readFileSync(CONFIG.lockFile, "utf8").trim(), 10);
    if (Number.isFinite(existingPid) && isPidAlive(existingPid)) {
      console.error(`❌ Another daemon is already running (PID ${existingPid}).`);
      console.error(`   Stop it first, or delete ${CONFIG.lockFile} if it's stale.`);
      process.exit(1);
    }
    console.log(`Removing stale lock (PID ${existingPid || "unknown"} not running).`);
  }
  fs.writeFileSync(CONFIG.lockFile, String(process.pid));
}

function releaseLock() {
  try {
    if (fs.existsSync(CONFIG.lockFile)) {
      const pid = Number.parseInt(fs.readFileSync(CONFIG.lockFile, "utf8").trim(), 10);
      if (pid === process.pid) fs.unlinkSync(CONFIG.lockFile);
    }
  } catch {
    // best-effort cleanup
  }
}

process.on("exit", releaseLock);
process.on("SIGINT", () => { releaseLock(); process.exit(0); });
process.on("SIGTERM", () => { releaseLock(); process.exit(0); });

// ─── Email Composer Skill (injected directly into system prompt) ──────────────

const EMAIL_COMPOSER_SKILL = `
# Email Composer Skill

## Voice & Persona
Write as a senior consultant: competent, respectful, and efficient. Confident but empathetic.

**Key principles:**
- Use "I" and "we" naturally and frequently
- Rhythm should sound like natural speech, not a formal report
- Concise: every sentence must add new information. Cut anything that doesn't.
- Simple sign-offs only: "Thanks," "Best," or similar.

## Rules

**Always avoid:**
- The word "flag" or "flagged" in any form
- Em dashes (—)
- Filler setup sentences ("I wanted to reach out...", "I hope this finds you well", "One thing I want to sort out...")
- Repetitive polite filler that restates what was just said
- Overly formal or bureaucratic phrasing

**Structure:**
- Lead with the main point or ask — no warm-up
- Group related information; don't scatter it
- Use a short list only when genuinely cleaner than prose
- Keep subject lines direct and specific

## Checklist Before Outputting
- No "flag" or "flagged"
- No em dashes
- No filler setup or warm-up sentences
- Every sentence adds new information
- Sounds like natural speech
- Sign-off is simple ("Thanks," / "Best,")
`;

// ─── State (tracks which emails we've already processed) ─────────────────────

function loadState() {
  if (fs.existsSync(CONFIG.stateFile)) {
    return JSON.parse(fs.readFileSync(CONFIG.stateFile, "utf8"));
  }
  return { processedIds: [], lastHistoryId: null };
}

function saveState(state) {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

// ─── Contact Memory ───────────────────────────────────────────────────────────
// Persists what Claude learns about each contact across runs.
// Shape: { "email@example.com": { name, relationship, tonality, notes, lastSeen } }

function loadContacts() {
  if (fs.existsSync(CONFIG.contactsFile)) {
    return JSON.parse(fs.readFileSync(CONFIG.contactsFile, "utf8"));
  }
  return {};
}

function saveContacts(contacts) {
  fs.writeFileSync(CONFIG.contactsFile, JSON.stringify(contacts, null, 2));
}

function formatContactMemory(contact) {
  if (!contact) return "No memory of this contact yet.";
  return [
    `Name: ${contact.name || "Unknown"}`,
    `Relationship to Andres: ${contact.relationship || "Unknown"}`,
    `Tonality: ${contact.tonality || "Unknown"}`,
    `Notes: ${contact.notes || "None"}`,
    `Last seen: ${contact.lastSeen || "Unknown"}`,
  ].join("\n");
}

// ─── Gmail Auth ───────────────────────────────────────────────────────────────

function getGmailClient() {
  const credentials = JSON.parse(fs.readFileSync(CONFIG.credentialsFile, "utf8"));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  const token = JSON.parse(fs.readFileSync(CONFIG.tokenFile, "utf8"));
  oAuth2Client.setCredentials(token);
  return google.gmail({ version: "v1", auth: oAuth2Client });
}

// ─── Gmail Helpers ────────────────────────────────────────────────────────────

function getHeader(headers, name) {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodeBody(payload) {
  const tryDecode = (data) => {
    if (!data) return null;
    return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  };

  if (payload.body?.data) return tryDecode(payload.body.data);

  if (payload.parts) {
    // Prefer plain text, fall back to HTML
    const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
    if (textPart?.body?.data) return tryDecode(textPart.body.data);
    const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
    if (htmlPart?.body?.data) {
      const html = tryDecode(htmlPart.body.data);
      // Strip HTML tags for a rough plain-text version
      return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

async function fetchNewEmails(gmail, state) {
  // Only unread messages in Inbox not sent by us (unopened / not yet read in Gmail)
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread label:inbox -from:me",
    maxResults: 20,
  });

  const messages = res.data.messages || [];
  const newMessages = messages.filter((m) => !state.processedIds.includes(m.id));

  const emails = [];
  for (const msg of newMessages) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const labelIds = full.data.labelIds || [];
    // Skip if no longer unread (e.g. opened in another client between list and get)
    if (!labelIds.includes("UNREAD")) continue;
    if (!labelIds.includes("INBOX")) continue;

    const headers = full.data.payload.headers;
    emails.push({
      id: msg.id,
      threadId: full.data.threadId,
      internalDate: full.data.internalDate,
      from: getHeader(headers, "from"),
      subject: getHeader(headers, "subject"),
      date: getHeader(headers, "date"),
      body: decodeBody(full.data.payload),
    });
  }

  emails.sort((a, b) => Number(b.internalDate || 0) - Number(a.internalDate || 0));
  return emails.map(({ internalDate, ...email }) => email);
}

async function checkIfKnownContact(gmail, senderEmail) {
  // Search sent mail for any email we've sent to this address
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `to:${senderEmail} in:sent`,
    maxResults: 1,
  });
  return (res.data.messages || []).length > 0;
}

async function fetchSenderContext(gmail, senderEmail) {
  // Get recent emails from this sender for context
  const res = await gmail.users.messages.list({
    userId: "me",
    q: `from:${senderEmail}`,
    maxResults: CONFIG.historyDepth,
  });

  const messages = res.data.messages || [];
  const context = [];

  for (const msg of messages) {
    const full = await gmail.users.messages.get({ userId: "me", id: msg.id, format: "full" });
    const headers = full.data.payload.headers;
    context.push({
      subject: getHeader(headers, "subject"),
      date: getHeader(headers, "date"),
      body: decodeBody(full.data.payload).slice(0, 500), // Cap context length
    });
  }

  return context;
}

async function createDraft(gmail, { to, subject, body, threadId }) {
  const raw = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\n");

  const encoded = Buffer.from(raw).toString("base64").replace(/\+/g, "-").replace(/\//g, "_");

  await gmail.users.drafts.create({
    userId: "me",
    requestBody: {
      message: {
        raw: encoded,
        threadId,
      },
    },
  });
}

// ─── AI Draft Generation ──────────────────────────────────────────────────────

function normalizeAssistantContent(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && part.text != null) return String(part.text);
        return "";
      })
      .join("");
  }
  return String(content);
}

function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function warnIfTruncated(response, what) {
  const reason = response?.choices?.[0]?.finish_reason;
  if (reason === "length") {
    console.warn(
      `     ⚠️  ${what}: response truncated at max_tokens (reasoning counts toward the budget). Raise NIM_MEMORY_MAX_TOKENS / NIM_DRAFT_MAX_TOKENS if needed.`,
    );
  }
}

function parseContactMemoryJson(rawText) {
  let s = rawText.trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```/m);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    const extracted = extractFirstJsonObject(s);
    if (!extracted) throw new Error("no JSON object");
    return JSON.parse(extracted);
  }
}

const client = new OpenAI({
  baseURL: "https://integrate.api.nvidia.com/v1",
  apiKey: process.env.NVIDIA_API_KEY,
  timeout: CONFIG.nimTimeoutMs,
  maxRetries: CONFIG.nimMaxRetries,
});

function formatErrorDetail(err) {
  const bits = [err.message];
  const c = err.cause;
  if (c instanceof Error) {
    if (!bits[0]?.includes(c.message)) bits.push(`${c.name}: ${c.message}`);
  } else if (c != null) {
    bits.push(String(c));
  }
  const code = err.code ?? c?.code;
  if (code) bits.push(`code=${code}`);
  return bits.filter(Boolean).join(" | ");
}

/**
 * Pass 1: Update contact memory based on the new email.
 * Returns an updated contact object with fresh observations.
 */
async function updateContactMemory(email, senderEmail, existingContact, senderContext) {
  const contextBlock = senderContext.length > 0
    ? senderContext.map((e) => `[${e.date}] Subject: "${e.subject}"\n${e.body}`).join("\n---\n")
    : "No prior emails available.";

  const response = await client.chat.completions.create({
    model: CONFIG.nimChatModel,
    max_tokens: CONFIG.nimMemoryMaxTokens,
    messages: [
      {
        role: "system",
        content: `You maintain a contact memory for Andres, a full-stack software engineer and CS student.
After reading an email, you update what you know about the sender.
Respond ONLY with a valid JSON object — no explanation, no markdown.`,
      },
      {
        role: "user",
        content: `Update the contact memory for this sender based on their email.

Current memory:
${JSON.stringify(existingContact || {}, null, 2)}

New email:
From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}
Body: ${email.body.slice(0, 800)}

Past emails from this sender:
${contextBlock}

Return a JSON object with these fields (infer or carry forward existing values):
{
  "name": "their full name if known",
  "relationship": "e.g. client, colleague, professor, recruiter, friend, vendor",
  "tonality": "how they write and how Andres should respond — e.g. formal, casual, technical, brief",
  "notes": "any specific context worth remembering — projects, preferences, ongoing topics",
  "lastSeen": "${new Date().toISOString()}"
}`,
      },
    ],
  });

  warnIfTruncated(response, "Contact memory");

  const raw = normalizeAssistantContent(response.choices[0]?.message?.content);
  if (!raw.trim()) {
    console.warn("     ⚠️  Contact memory: empty model response. (reasoning may have consumed token budget)");
    return existingContact || {};
  }
  try {
    return parseContactMemoryJson(raw);
  } catch (parseErr) {
    const preview = raw.slice(0, 300).replace(/\s+/g, " ");
    console.warn(`     ⚠️  Contact memory parse failed: ${parseErr.message}`);
    console.warn(`     Raw response preview: ${preview}`);
    return existingContact || {};
  }
}

/**
 * Pass 2: Generate the draft reply using the email composer skill + contact memory.
 */
async function generateDraft(email, contact, senderContext) {
  const contextBlock = senderContext.length > 0
    ? `\n\nPast emails from this sender:\n${senderContext
        .map((e) => `[${e.date}] Subject: "${e.subject}"\n${e.body}`)
        .join("\n---\n")}`
    : "";

  const response = await client.chat.completions.create({
    model: CONFIG.nimChatModel,
    max_tokens: CONFIG.nimDraftMaxTokens,
    messages: [
      {
        role: "system",
        content: `You are drafting email replies on behalf of Andres, a full-stack software engineer and CS student.

${EMAIL_COMPOSER_SKILL}

You keep memories of everyone Andres emails — their relationship to him, their tonality, and relevant context — and use that to calibrate every reply.

Sign all emails as: Andres
Write ONLY the email body and sign-off. Do not include subject line or headers.`,
      },
      {
        role: "user",
        content: `Draft a reply to this email.

--- CONTACT MEMORY ---
${formatContactMemory(contact)}

--- INCOMING EMAIL ---
From: ${email.from}
Subject: ${email.subject}
Date: ${email.date}

${email.body.slice(0, 1500)}${contextBlock}`,
      },
    ],
  });

  warnIfTruncated(response, "Draft");

  const text = normalizeAssistantContent(response.choices[0]?.message?.content).trim();
  if (!text) {
    throw new Error("Language model returned an empty draft body.");
  }
  return text;
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

function extractEmailAddress(fromHeader) {
  // Handle "Name <email@example.com>" or just "email@example.com"
  const match = fromHeader.match(/<(.+?)>/);
  return match ? match[1] : fromHeader.trim();
}

async function processEmails() {
  const state = loadState();
  const contacts = loadContacts();
  let gmail;

  try {
    gmail = getGmailClient();
  } catch (err) {
    console.error("❌ Gmail auth failed:", err.message);
    console.error("   Run `node auth.js` to authenticate first.");
    return;
  }

  let newEmails;
  try {
    newEmails = await fetchNewEmails(gmail, state);
  } catch (err) {
    console.error("❌ Failed to fetch emails:", err.message);
    return;
  }

  if (newEmails.length === 0) {
    console.log(`[${new Date().toISOString()}] No new emails.`);
    return;
  }

  console.log(`[${new Date().toISOString()}] Found ${newEmails.length} new email(s).`);

  for (const email of newEmails) {
    const senderEmail = extractEmailAddress(email.from);
    console.log(`  → Processing: "${email.subject}" from ${senderEmail}`);

    try {
      // Known if seeded in .contacts.json, else fall back to a Gmail sent-mail check
      const isKnown =
        Object.prototype.hasOwnProperty.call(contacts, senderEmail) ||
        (await checkIfKnownContact(gmail, senderEmail));
      if (!isKnown) {
        console.log(`     Skipped (unknown contact)`);
        state.processedIds.push(email.id);
        continue;
      }

      // Fetch recent emails from this sender for context
      const context = await fetchSenderContext(gmail, senderEmail);

      // Two LLM calls run one after another; each await waits for NIM's full completion payload.
      // Pass 1: Update contact memory
      const existingContact = contacts[senderEmail];
      console.log(`     Updating contact memory...`);
      const updatedContact = await updateContactMemory(email, senderEmail, existingContact, context);
      contacts[senderEmail] = updatedContact;
      saveContacts(contacts);
      console.log(`     Memory: ${updatedContact.relationship || "?"} | Tone: ${updatedContact.tonality || "?"}`);

      // Pass 2: Generate the draft using skill + memory
      const draftBody = await generateDraft(email, updatedContact, context);

      // Save it to Gmail drafts
      const replySubject = email.subject.startsWith("Re:")
        ? email.subject
        : `Re: ${email.subject}`;

      await createDraft(gmail, {
        to: email.from,
        subject: replySubject,
        body: draftBody,
        threadId: email.threadId,
      });

      console.log(`     ✅ Draft created`);
    } catch (err) {
      const status = err.status ?? err.response?.status;
      const suffix = status != null ? ` [HTTP ${status}]` : "";
      console.error(`     ❌ Error${suffix}: ${formatErrorDetail(err)}`);
    }

    // Mark as processed regardless of success to avoid infinite retries
    state.processedIds.push(email.id);
  }

  // Keep state from growing unbounded — keep last 500 processed IDs
  state.processedIds = state.processedIds.slice(-500);
  saveState(state);
}

async function main() {
  acquireLock();
  console.log("Email Auto-Drafter started");
  console.log(`   Poll interval: ${CONFIG.pollIntervalMs / 1000}s`);
  console.log(`   NIM HTTP timeout: ${CONFIG.nimTimeoutMs / 60_000} min · maxRetries: ${CONFIG.nimMaxRetries}`);

  // Run immediately on start, then on interval
  await processEmails();
  setInterval(processEmails, CONFIG.pollIntervalMs);
}

main().catch(console.error);
