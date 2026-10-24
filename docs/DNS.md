# DNS records for eeeseminar.org

DNS lives in Cloudflare, where the domain was bought (Cloudflare Registrar, 24 Oct 2026).
`tools/cf-setup.mjs` creates all of this; the table is what it should look like.

| Type | Name | Value | Purpose |
|---|---|---|---|
| A ×4 | `eeeseminar.org` | `185.199.108.153`, `.109.153`, `.110.153`, `.111.153`, DNS only (grey cloud) | the public site on GitHub Pages |
| AAAA ×4 | `eeeseminar.org` | `2606:50c0:8000::153` … `8003::153`, DNS only | the same over IPv6 |
| CNAME | `www` | `affluxseminar.github.io`, DNS only | GitHub Pages redirects www to the apex |
| — | `admin.eeeseminar.org` | Worker custom domain (`wrangler.toml`), behind Cloudflare Access | the admin |
| MX | `eeeseminar.org` | the three `route*.mx.cloudflare.net` hosts that Email Routing gives you | incoming mail to `seminar@eeeseminar.org` |
| TXT | `eeeseminar.org` | `v=spf1 include:_spf.mx.cloudflare.net include:spf.smtp2go.com ~all` | who may send as `@eeeseminar.org`: Email Routing (forwarding) and SMTP2GO |
| TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:seminar@eeeseminar.org; adkim=r; aspf=r` | DMARC reports; switch to `quarantine` after two weeks of clean reports |

The public site must stay DNS only: Russian providers throttle Cloudflare-proxied sites, GitHub
Pages they do not. In GitHub: Settings → Pages → custom domain `eeeseminar.org`, Enforce HTTPS.

Email Routing: Cloudflare → Email → Email Routing → destination address = the mailbox you read
(verified once, account-wide) → rule `seminar@eeeseminar.org → destination`.

Replies from a mail client (or Gmail's "Send mail as"), if ever needed: outgoing server
`mail.smtp2go.com`, port 587 (STARTTLS), with an SMTP user created in SMTP2GO; its three CNAME
records (DKIM, return path) then go here too.

## The former domains: affluxseminar.org and affluxseminar.com

The seminar was AFFLUX until 24 Oct 2026. Both domains stay registered (renewal October 2027) and
only redirect, so that old links and announcements keep working:

| Type | Name | Value | Purpose |
|---|---|---|---|
| Redirect rule | `admin.affluxseminar.org` | `https://admin.eeeseminar.org` + path, 301 | the old admin address |
| Redirect rule | everything else on affluxseminar.org and .com | `https://eeeseminar.org` + path, 301 | old links land on the same page |
| A / AAAA | `@`, `www`, `admin` | `192.0.2.1` / `100::`, proxied (placeholders the rules attach to) | — |
| MX, SPF, rule | affluxseminar.org | unchanged | mail to `seminar@affluxseminar.org` still arrives |

A 301 is small enough to pass the throttling of Cloudflare-proxied hosts. Use eeeseminar.org
everywhere; mention the former domains nowhere.
