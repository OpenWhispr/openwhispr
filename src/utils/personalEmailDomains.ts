const PERSONAL_EMAIL_DOMAINS = new Set<string>([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "rocketmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "fastmail.com",
  "fastmail.fm",
  "tutanota.com",
  "tuta.io",
  "gmx.com",
  "gmx.de",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "yandex.ru",
  "duck.com",
  "hey.com",
  "qq.com",
  "163.com",
  "126.com",
  "sina.com",
]);

export function emailDomain(email: string): string {
  if (typeof email !== "string") return "";
  const trimmed = email.trim();
  const angle = /<([^<>]+)>/.exec(trimmed);
  const addr = (angle ? angle[1] : trimmed).trim();
  const at = addr.lastIndexOf("@");
  if (at === -1) return "";
  return addr
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

export function isPersonalEmailDomain(domain: string): boolean {
  if (typeof domain !== "string") return false;
  return PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase());
}
