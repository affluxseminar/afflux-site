# DNS records for affluxseminar.org (template)

Replace `affluxseminar.org` with the real domain. DNS lives in Cloudflare; the domain can be bought
there too (Cloudflare Registrar), which keeps the number of providers at a minimum.

| Type | Name | Value | Purpose |
|---|---|---|---|
| — | `affluxseminar.org` | Worker custom domain (set in Cloudflare → Workers → afflux-server → Domains) | the site and the server |
| MX | `affluxseminar.org` | the three `route*.mx.cloudflare.net` hosts that Email Routing gives you | incoming mail to `seminar@affluxseminar.org` |
| TXT | `affluxseminar.org` | `v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all` | who may send as `@affluxseminar.org`: Email Routing (forwarding) and SMTP2GO |
| CNAME ×3 | as given by SMTP2GO → Sending → Verified Senders → Domains | SMTP2GO's DKIM and return-path records | SMTP2GO's signature and bounce handling |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:seminar@affluxseminar.org; adkim=r; aspf=r` | ask receivers to quarantine unauthenticated mail; the setup script starts with `p=none` — switch to `quarantine` after two weeks of clean reports |

Email Routing: Cloudflare → Email → Email Routing → destination address = the mailbox you read
(it is verified once by a message to that mailbox) → rule `seminar@affluxseminar.org → destination`.

Replies from a mail client (or Gmail's "Send mail as"): outgoing server `mail.smtp2go.com`,
port 587 (STARTTLS), user and password = an SMTP user created in SMTP2GO → Sending → SMTP Users.

Watching delivery: SMTP2GO's own reports show delivered, bounced and rejected per receiver;
for DMARC aggregate reports point `rua=` at a free DMARC report reader (for example
dmarcian's free tier or Cloudflare's DMARC Management, which is built into the dashboard).
Nothing is registered with any Russian provider.

Reading mailbox: any mailbox outside Russian providers — Yahoo, or a domain mailbox at Infomaniak
(Switzerland), mailbox.org (Germany) or Migadu (Switzerland). Email Routing forwards to it; the
choice can be changed at any time by editing one rule.

## The second domain: affluxseminar.com

Bought alongside the .org so that nobody else can. It is never a second site: add it as a zone in
the same Cloudflare account and

| Type | Name | Value | Purpose |
|---|---|---|---|
| Redirect rule | every request to the .com, and `www.affluxseminar.org` on the .org | `https://affluxseminar.org` + path, 301 (single redirect rules; `tools/cf-setup.mjs` creates them) | one address in links, search engines and mail signatures |
| A / AAAA | `@` and `www` | `192.0.2.1` / `100::` proxied (a placeholder so the redirect rule has something to attach to) | — |
| CNAME (on the .org) | `www` | `affluxseminar.org`, proxied | lets the www redirect fire |
| TXT | `@` | `v=spf1 -all` | no mail is ever sent from the .com |
| TXT | `_dmarc` | `v=DMARC1; p=reject; rua=mailto:seminar@affluxseminar.org` | spoofed mail "from" the .com is rejected |
| — | no MX records | | the .com receives no mail either |

Use the .org everywhere; mention the .com nowhere.
