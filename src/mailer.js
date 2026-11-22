// E-mail for the portal's login codes (SMTP_* in .env). Reads the settings on every send,
// so `watchdog-main reload` picks up SMTP changes.
import nodemailer from "nodemailer";

export function createMailer(cfg) {
  let transport = null;
  let key = "";
  const send = async ({ to, subject, text }) => {
    if (!cfg.smtpHost) throw new Error("SMTP is not set up (SMTP_HOST)");
    const port = cfg.smtpPort || 587;
    const k = [cfg.smtpHost, port, cfg.smtpUser, cfg.smtpPass, cfg.smtpSecure].join("|");
    if (k !== key) {
      transport = nodemailer.createTransport({
        host: cfg.smtpHost,
        port,
        secure: cfg.smtpSecure ?? port === 465, // 465 = TLS from the start; 587 = STARTTLS
        auth: cfg.smtpUser ? { user: cfg.smtpUser, pass: cfg.smtpPass } : undefined,
        connectionTimeout: 15_000,
        greetingTimeout: 15_000,
      });
      key = k;
    }
    await transport.sendMail({ from: cfg.smtpFrom || cfg.smtpUser, to, subject, text });
  };
  send.available = () => Boolean(cfg.smtpHost);
  return send;
}
