#!/usr/bin/env node

/**
 * auth.js — Run this ONCE to authenticate with Gmail.
 * It opens a browser, you approve access, and it saves a token.json.
 * After that, index.js uses the token automatically.
 */

import { google } from "googleapis";
import fs from "fs";
import path from "path";
import readline from "readline";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CREDENTIALS_FILE = path.join(__dirname, "credentials.json");
const TOKEN_FILE = path.join(__dirname, "token.json");

// Scopes needed: read mail + create drafts
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.compose",
];

async function authenticate() {
  if (!fs.existsSync(CREDENTIALS_FILE)) {
    console.error("❌ credentials.json not found.");
    console.error("   Download it from Google Cloud Console → APIs & Services → Credentials.");
    console.error("   See README.md for full instructions.");
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, "utf8"));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  const authUrl = oAuth2Client.generateAuthUrl({ access_type: "offline", scope: SCOPES });

  console.log("\n🔐 Gmail Authorization\n");
  console.log("1. Open this URL in your browser:\n");
  console.log("   " + authUrl);
  console.log("\n2. Approve the permissions");
  console.log("3. Copy the authorization code and paste it below\n");

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const code = await new Promise((resolve) => rl.question("Authorization code: ", resolve));
  rl.close();

  const { tokens } = await oAuth2Client.getToken(code.trim());
  oAuth2Client.setCredentials(tokens);

  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2));
  console.log("\n✅ token.json saved. You can now run: node index.js");
}

authenticate().catch(console.error);
