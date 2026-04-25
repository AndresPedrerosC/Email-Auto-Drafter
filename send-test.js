#!/usr/bin/env node

/**
 * send-test.js — One-shot test sender. Sends an email from a secondary Gmail account
 * (via SMTP + app password) to the primary Gmail address being monitored by index.js,
 * so the full pipeline (receive → contact memory → draft creation) can be verified
 * end-to-end.
 *
 * Requires (in .env):
 *   SENDER_EMAIL         secondary Gmail address
 *   SENDER_APP_PASSWORD  16-char Google app password (myaccount.google.com/apppasswords)
 *
 * Usage:
 *   npm run send-test
 *   node send-test.js --subject "..." --body "..."
 */

import "dotenv/config";
import nodemailer from "nodemailer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTACTS_FILE = path.join(__dirname, ".contacts.json");
const RECIPIENT = "pedrerosandres99@gmail.com";

function ensureKnownContact(senderEmail) {
  const contacts = fs.existsSync(CONTACTS_FILE)
    ? JSON.parse(fs.readFileSync(CONTACTS_FILE, "utf8"))
    : {};
  if (!Object.prototype.hasOwnProperty.call(contacts, senderEmail)) {
    contacts[senderEmail] = {};
    fs.writeFileSync(CONTACTS_FILE, JSON.stringify(contacts, null, 2));
    console.log(`📝 Added ${senderEmail} to .contacts.json so the daemon will process it.`);
  }
}

const DEFAULT_BODY = `Hey Andres,

Quick check-in on the project we discussed last week. I wanted to confirm
the timeline for the data ingestion piece — are we still aiming for end of
month? Also, let me know if you need any more context on the schema we
talked about.

Thanks,
Test Sender`;

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--subject") args.subject = argv[++i];
    else if (argv[i] === "--body") args.body = argv[++i];
  }
  return args;
}

async function main() {
  const user = process.env.SENDER_EMAIL;
  const pass = process.env.SENDER_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error(
      "SENDER_EMAIL and SENDER_APP_PASSWORD must be set in .env. " +
      "Generate a Google app password at https://myaccount.google.com/apppasswords (requires 2FA)."
    );
  }

  if (user.toLowerCase() === RECIPIENT.toLowerCase()) {
    throw new Error(
      `SENDER_EMAIL must be different from the recipient (${RECIPIENT}). ` +
      "Use a secondary Gmail account so the daemon's -from:me filter doesn't drop the email."
    );
  }

  const args = parseArgs(process.argv);
  const subject = args.subject || `Feedback Loop Check — ${new Date().toISOString()}`;
  const body = args.body || DEFAULT_BODY;

  ensureKnownContact(user);

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 465,
    secure: true,
    auth: { user, pass },
  });

  console.log(`📤 Sending test email`);
  console.log(`   From:    ${user}`);
  console.log(`   To:      ${RECIPIENT}`);
  console.log(`   Subject: ${subject}`);

  const info = await transporter.sendMail({
    from: user,
    to: RECIPIENT,
    subject,
    text: body,
  });

  console.log(`✅ Sent (messageId: ${info.messageId})`);
  console.log("   Run `npm start` (or wait for the daemon's next poll) to process it.");
}

main().catch((err) => {
  console.error("❌", err.message);
  if (err.code) console.error(`   code: ${err.code}`);
  process.exit(1);
});
