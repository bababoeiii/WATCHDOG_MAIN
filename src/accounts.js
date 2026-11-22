// Web portal accounts: roles, invites, passwords (scrypt), second step (TOTP app or e-mail code),
// Telegram login, and cookie sessions. Everything is kept in the main store (data/watchdog.json);
// only hashes of passwords, invite links, codes and session tokens are stored.
import crypto from "node:crypto";

export const ROLES = ["owner", "staff", "user"];
export const ROLE_LABEL = { owner: "Owner", staff: "Staff", user: "User" };

const SESSION_DAYS_DEFAULT = 7;
const INVITE_HOURS = 48;
const TICKET_MS = 5 * 60_000; // between "password ok" and "code ok"
const EMAIL_CODE_MS = 10 * 60_000;
const EMAIL_RESEND_MS = 60_000;
const MAX_CODE_TRIES = 5;
const FAIL_WINDOW_MS = 15 * 60_000;
const MAX_FAILS = 10; // per username and per IP, in FAIL_WINDOW_MS
export const MIN_PASSWORD = 10;

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
const nowMs = () => Date.now();
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- passwords (scrypt)
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$8$1$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function checkPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, N, r, p, salt, hash] = parts;
  const want = Buffer.from(hash, "base64");
  const got = crypto.scryptSync(String(password), Buffer.from(salt, "base64"), want.length, { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(want, got);
}

// ---------------------------------------------------------------- TOTP (RFC 6238, SHA-1, 30 s, 6 digits)
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of String(str).toUpperCase().replace(/[=\s]/g, "")) {
    const i = B32.indexOf(c);
    if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function totpCode(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}
/** @returns the matching time step (to refuse its reuse), or null */
export function verifyTotp(secret, code, { at = nowMs(), window = 1 } = {}) {
  const c = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(c)) return null;
  const step = Math.floor(at / 30_000);
  for (let d = -window; d <= window; d++) if (safeEqual(totpCode(secret, step + d), c)) return step + d;
  return null;
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
export const otpauthUrl = (secret, username, issuer = "Watchdog") =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------------------------------------------------------------- Telegram Login Widget
// https://core.telegram.org/widgets/login#checking-authorization
export function verifyTelegramLogin(data, botToken, maxAgeSeconds = 3600) {
  if (!data || typeof data !== "object" || !data.hash) return null;
  const check = Object.keys(data)
    .filter((k) => k !== "hash" && data[k] !== undefined && data[k] !== null)
    .sort()
    .map((k) => `${k}=${data[k]}`)
    .join("\n");
  const secret = crypto.createHash("sha256").update(botToken).digest();
  const expected = crypto.createHmac("sha256", secret).update(check).digest("hex");
  if (!safeEqual(expected, String(data.hash))) return null;
  const authDate = Number(data.auth_date);
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSeconds) return null;
  const id = Number(data.id);
  return Number.isSafeInteger(id) ? { id, first_name: String(data.first_name || ""), username: data.username ? String(data.username) : null } : null;
}

// ---------------------------------------------------------------- the account store
export class Accounts {
  /**
   * @param store    Store (data.accounts and data.sessions live in it)
   * @param cfg      config (adminIds = Telegram owners, sessionDays)
   * @param mailer   async ({ to, subject, text }) => void, or null when SMTP isn't set up
   */
  constructor(store, cfg, mailer = null) {
    this.store = store;
    this.cfg = cfg;
    this.mailer = mailer;
    this.dummyHash = hashPassword(crypto.randomBytes(8).toString("hex")); // for timing-safe "no such user"
    this.tickets = new Map(); // login ticket -> { accountId, method, expires, tries }
    this.links = new Map(); // one-time login link (from the bot's /portal) -> { tgId, expires }
    this.fails = new Map(); // "u:name" / "ip:1.2.3.4" -> [timestamps]
  }

  /** Can e-mail codes be sent (SMTP configured)? */
  emailAvailable() {
    return Boolean(this.mailer && (this.mailer.available ? this.mailer.available() : true));
  }

  get list() {
    return this.store.data.accounts;
  }
  get sessions() {
    return this.store.data.sessions;
  }

  all() {
    return Object.values(this.list).sort((a, b) => a.username.localeCompare(b.username));
  }
  get(id) {
    return typeof id === "string" && Object.hasOwn(this.list, id) ? this.list[id] : null;
  }
  byName(username) {
    const u = String(username || "").trim().toLowerCase();
    return this.all().find((a) => a.username === u) || null;
  }

  /** What the portal may show about an account (never hashes or secrets). */
  view(a) {
    return {
      id: a.id, username: a.username, role: a.role, servers: [...(a.servers || [])], email: a.email || null,
      telegram_id: a.telegramId ?? null, twofa: a.twofa || null, disabled: Boolean(a.disabled),
      invited: Boolean(a.invite), invite_expires: a.invite ? a.invite.expires / 1000 : null,
      created_at: a.createdAt, created_by: a.createdBy || null, last_login: a.lastLogin || null,
    };
  }

  // ---------------------------------------------------------------- owner: manage accounts
  validate({ username, role, servers, email, telegramId }, existingId = null) {
    if (username !== undefined) {
      const u = String(username).trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(u)) throw new Error("Username: 3-32 characters, a-z 0-9 . _ - (starting with a letter or digit)");
      if (this.all().some((a) => a.username === u && a.id !== existingId)) throw new Error(`"${u}" already exists`);
    }
    if (role !== undefined && !ROLES.includes(role)) throw new Error("Role must be owner, staff or user");
    if (servers !== undefined && !Array.isArray(servers)) throw new Error("servers must be a list");
    if (email !== undefined && email !== null && email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email))) throw new Error("Invalid e-mail address");
    if (telegramId !== undefined && telegramId !== null && telegramId !== "" && !Number.isSafeInteger(Number(telegramId))) throw new Error("Telegram ID must be a number");
  }

  /** @returns {{ account, inviteToken }} */
  create({ username, role = "user", servers = [], email = "", telegramId = null }, createdBy) {
    this.validate({ username, role, servers, email, telegramId });
    let id;
    do id = crypto.randomBytes(6).toString("hex");
    while (this.get(id));
    const a = {
      id, username: String(username).trim().toLowerCase(), role, servers: [...new Set(servers.map(String))],
      email: email ? String(email).trim() : null, telegramId: telegramId === null || telegramId === "" ? null : Number(telegramId),
      twofa: null, passwordHash: null, totpSecret: null, createdAt: nowMs() / 1000, createdBy: createdBy || null, disabled: false,
    };
    this.list[id] = a;
    const inviteToken = this.newInvite(a);
    return { account: a, inviteToken };
  }

  update(id, changes) {
    const a = this.get(id);
    if (!a) throw new Error("Unknown account");
    const { role, servers, email, telegramId, disabled } = changes;
    this.validate({ role, servers, email, telegramId }, id);
    if (role !== undefined) a.role = role;
    if (servers !== undefined) a.servers = [...new Set(servers.map(String))];
    if (email !== undefined) a.email = email ? String(email).trim() : null;
    if (telegramId !== undefined) a.telegramId = telegramId === null || telegramId === "" ? null : Number(telegramId);
    if (disabled !== undefined) {
      a.disabled = Boolean(disabled);
      if (a.disabled) this.endSessionsOf(id);
    }
    this.store.save();
    return a;
  }

  /** New password + second step needed: a fresh invite link, all sessions ended. */
  reset(id) {
    const a = this.get(id);
    if (!a) throw new Error("Unknown account");
    a.passwordHash = null;
    a.totpSecret = null;
    a.twofa = null;
    this.endSessionsOf(id);
    return this.newInvite(a);
  }

  remove(id) {
    if (!this.get(id)) return false;
    this.endSessionsOf(id);
    delete this.list[id];
    this.store.save();
    return true;
  }

  /** A server was removed: drop it from every assignment. */
  forgetServer(serverId) {
    for (const a of this.all()) if (a.servers?.includes(serverId)) a.servers = a.servers.filter((x) => x !== serverId);
    this.store.save();
  }

  assign(id, serverId) {
    const a = this.get(id);
    if (a && !a.servers.includes(serverId)) {
      a.servers.push(serverId);
      this.store.save();
    }
  }

  unassign(id, serverId) {
    const a = this.get(id);
    if (a && a.servers.includes(serverId)) {
      a.servers = a.servers.filter((x) => x !== serverId);
      this.store.save();
    }
  }

  newInvite(a) {
    const token = randomToken();
    a.invite = { hash: sha256(token), expires: nowMs() + INVITE_HOURS * 3600_000 };
    this.store.save();
    return token;
  }

  // ---------------------------------------------------------------- invite: set password + second step
  byInvite(token) {
    const h = sha256(token);
    const a = this.all().find((x) => x.invite && safeEqual(x.invite.hash, h));
    if (!a || a.disabled) return null;
    if (a.invite.expires < nowMs()) return null;
    return a;
  }

  /** Step 1 of the TOTP setup: a secret to scan (kept on the invite until it's confirmed). */
  inviteTotp(token) {
    const a = this.byInvite(token);
    if (!a) throw new Error("This invite link is invalid or has expired. Ask an owner for a new one.");
    a.invite.totpSecret ||= newTotpSecret();
    this.store.save();
    return { secret: a.invite.totpSecret, url: otpauthUrl(a.invite.totpSecret, a.username) };
  }

  /** Step 1 of the e-mail setup: send a code to the address. */
  async inviteEmail(token, email) {
    const a = this.byInvite(token);
    if (!a) throw new Error("This invite link is invalid or has expired. Ask an owner for a new one.");
    if (!this.emailAvailable()) throw new Error("E-mail codes aren't set up on this server (SMTP). Use an authenticator app.");
    this.validate({ email });
    if (!email) throw new Error("Enter an e-mail address");
    if (a.invite.emailSentAt && nowMs() - a.invite.emailSentAt < EMAIL_RESEND_MS) throw new Error("A code was just sent. Wait a minute before asking for another.");
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    a.invite.email = String(email).trim();
    a.invite.emailCode = sha256(code);
    a.invite.emailCodeExp = nowMs() + EMAIL_CODE_MS;
    a.invite.emailSentAt = nowMs();
    a.invite.tries = 0;
    this.store.save();
    await this.mailer({ to: a.invite.email, subject: "Watchdog: your code", text: `Your Watchdog code: ${code}\n\nIt is valid for 10 minutes.` });
  }

  /** Last step: password + confirmed code → the account is ready. */
  finishInvite(token, { password, method, code }) {
    const a = this.byInvite(token);
    if (!a) throw new Error("This invite link is invalid or has expired. Ask an owner for a new one.");
    if (String(password || "").length < MIN_PASSWORD) throw new Error(`The password needs at least ${MIN_PASSWORD} characters`);
    if (String(password).length > 200) throw new Error("That password is too long");
    const inv = a.invite;
    if ((inv.tries = (inv.tries || 0) + 1) > MAX_CODE_TRIES * 2) throw new Error("Too many wrong codes. Ask an owner for a new invite link.");
    if (method === "totp") {
      if (!inv.totpSecret) throw new Error("Start the authenticator setup first");
      const step = verifyTotp(inv.totpSecret, code);
      if (step === null) {
        this.store.save();
        throw new Error("Wrong code. Check the time on your phone and try the newest code.");
      }
      a.totpSecret = inv.totpSecret;
      a.lastTotpStep = step;
      a.twofa = "totp";
    } else if (method === "email") {
      if (!inv.emailCode || inv.emailCodeExp < nowMs()) throw new Error("The code has expired. Send a new one.");
      if (!safeEqual(sha256(String(code || "").trim()), inv.emailCode)) {
        this.store.save();
        throw new Error("Wrong code");
      }
      a.email = inv.email;
      a.twofa = "email";
    } else {
      throw new Error("Choose an authenticator app or e-mail codes");
    }
    a.passwordHash = hashPassword(password);
    delete a.invite;
    this.store.save();
    return a;
  }

  // ---------------------------------------------------------------- login
  failed(key) {
    const now = nowMs();
    const list = (this.fails.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    list.push(now);
    this.fails.set(key, list);
  }
  blocked(key) {
    const now = nowMs();
    const list = (this.fails.get(key) || []).filter((t) => now - t < FAIL_WINDOW_MS);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list.length >= MAX_FAILS;
  }
  tooMany(username, ip) {
    return this.blocked(`u:${String(username).toLowerCase()}`) || this.blocked(`ip:${ip}`);
  }

  /** Step 1: username + password. @returns {{ ticket, method }} for step 2 */
  async login(username, password, ip) {
    if (this.tooMany(username, ip)) throw Object.assign(new Error("Too many failed attempts. Try again in 15 minutes."), { status: 429 });
    const a = this.byName(username);
    // always run scrypt, so a wrong username takes as long as a wrong password
    const ok = checkPassword(password, a?.passwordHash || this.dummyHash);
    if (!a || !ok || a.disabled || !a.passwordHash || !a.twofa) {
      this.failed(`u:${String(username).toLowerCase()}`);
      this.failed(`ip:${ip}`);
      throw Object.assign(new Error("Wrong username or password"), { status: 401 });
    }
    const ticket = randomToken();
    const t = { accountId: a.id, method: a.twofa, expires: nowMs() + TICKET_MS, tries: 0 };
    if (a.twofa === "email") {
      if (!this.emailAvailable()) throw Object.assign(new Error("E-mail codes aren't available right now (SMTP not set up). Ask an owner."), { status: 503 });
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      t.emailCode = sha256(code);
      await this.mailer({ to: a.email, subject: "Watchdog: your login code", text: `Your Watchdog login code: ${code}\n\nIt is valid for 5 minutes. If you didn't try to log in, change your password (ask an owner).` });
    }
    this.tickets.set(sha256(ticket), t);
    return { ticket, method: a.twofa, email: a.twofa === "email" ? maskEmail(a.email) : null };
  }

  /** Step 2: the code. @returns the account */
  verify(ticket, code, ip) {
    const key = sha256(ticket);
    const t = this.tickets.get(key);
    if (!t || t.expires < nowMs()) {
      this.tickets.delete(key);
      throw Object.assign(new Error("The login took too long. Start again."), { status: 401 });
    }
    const a = this.get(t.accountId);
    if (!a || a.disabled) throw Object.assign(new Error("Account not available"), { status: 401 });
    let ok = false;
    if (t.method === "totp") {
      const step = verifyTotp(a.totpSecret, code);
      ok = step !== null && step > (a.lastTotpStep ?? -1); // each code works once
      if (ok) a.lastTotpStep = step;
    } else {
      ok = safeEqual(sha256(String(code || "").trim()), t.emailCode);
    }
    if (!ok) {
      this.failed(`ip:${ip}`);
      if (++t.tries >= MAX_CODE_TRIES) this.tickets.delete(key);
      throw Object.assign(new Error(t.tries >= MAX_CODE_TRIES ? "Too many wrong codes. Start again." : "Wrong code"), { status: 401 });
    }
    this.tickets.delete(key);
    a.lastLogin = nowMs() / 1000;
    this.store.save();
    return a;
  }

  /** One-time login link for a Telegram owner, sent by the bot (/portal). Valid 10 minutes, once. */
  loginLink(tgId, name = null) {
    const token = randomToken();
    const now = nowMs();
    for (const [k, l] of this.links) if (l.expires < now) this.links.delete(k);
    this.links.set(sha256(token), { tgId, name, expires: now + 10 * 60_000 });
    return token;
  }
  useLoginLink(token) {
    const key = sha256(token);
    const l = this.links.get(key);
    this.links.delete(key);
    if (!l || l.expires < nowMs() || !this.cfg.adminIds.includes(l.tgId)) return null;
    return { type: "tg", id: l.tgId, name: l.name };
  }

  /** Telegram login: an owner (ADMIN_IDS) or an account linked to that Telegram ID. */
  telegramIdentity(tgUser) {
    if (this.cfg.adminIds.includes(tgUser.id)) return { type: "tg", id: tgUser.id, name: tgName(tgUser) };
    const a = this.all().find((x) => x.telegramId === tgUser.id && !x.disabled && !x.invite);
    if (!a) return null;
    a.lastLogin = nowMs() / 1000;
    this.store.save();
    return { type: "account", id: a.id };
  }

  // ---------------------------------------------------------------- sessions
  /** @returns the cookie value */
  startSession(who, { ip = "", ua = "" } = {}) {
    const token = randomToken();
    const days = Number(this.cfg.sessionDays) || SESSION_DAYS_DEFAULT;
    this.sessions[sha256(token)] = { who, created: nowMs() / 1000, expires: nowMs() / 1000 + days * 86400, ip: String(ip).slice(0, 60), ua: String(ua).slice(0, 160) };
    this.pruneSessions();
    this.store.save();
    return token;
  }

  endSession(token) {
    delete this.sessions[sha256(token)];
    this.store.save();
  }

  endSessionsOf(accountId) {
    for (const [k, s] of Object.entries(this.sessions)) if (s.who.type === "account" && s.who.id === accountId) delete this.sessions[k];
    this.store.save();
  }

  pruneSessions() {
    const now = nowMs() / 1000;
    for (const [k, s] of Object.entries(this.sessions)) if (s.expires < now) delete this.sessions[k];
  }

  /**
   * Who is behind this session cookie, as the portal sees them.
   * @returns {{ key, name, role, servers: Set|null (null = all), accountId?, telegramId? } | null}
   */
  identify(token) {
    if (!token) return null;
    const key = sha256(token);
    const s = this.sessions[key];
    if (!s || s.expires < nowMs() / 1000) return null;
    if (s.who.type === "tg") {
      if (!this.cfg.adminIds.includes(s.who.id)) return null; // no longer an admin
      return { key, name: s.who.name || `Telegram ${s.who.id}`, role: "owner", servers: null, telegramId: s.who.id };
    }
    const a = this.get(s.who.id);
    if (!a || a.disabled || a.invite) return null; // a reset account has to finish its new invite first
    return { key, name: a.username, role: a.role, servers: a.role === "owner" ? null : new Set(a.servers || []), accountId: a.id };
  }
}

/** How a Telegram owner is named in the portal and the activity log. */
export const tgName = (u) => String(u?.username ? `@${u.username}` : u?.first_name || `Telegram ${u?.id}`).slice(0, 60);

export function maskEmail(email) {
  const [user, domain] = String(email || "").split("@");
  if (!domain) return "";
  return `${user.slice(0, 2)}${"•".repeat(Math.max(1, user.length - 2))}@${domain}`;
}
