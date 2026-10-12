# Staging test checklist

Run on `test.affluxseminar.org` before the real launch. Tick each line; anything that fails is fixed
and re-run before moving on. Use at least two real mailboxes (one Gmail, one Mail.ru or Outlook)
and two devices (a phone and a computer). Where it says "from Russia", use a Russian network
without VPN; where it says "from abroad", any non-Russian network or a foreign SIM.

## Reachability
- [ ] Site opens from Russia without VPN, on phone and computer, on at least three networks
      (home provider, MTS/Beeline/MegaFon mobile, a second provider); every page loads completely —
      a page that stops after its first kilobytes, missing fonts or a frozen figure means the host's
      network is throttled from Russia (see docs/LAUNCH.md, "Where to host"); fonts load, the field animates.
- [ ] Site opens from abroad.
- [ ] Safari (iPhone and Mac), Chrome, Firefox: front page, a talk page, register page, account page.

## Registration and sign-in
- [ ] Register with mailbox A from a phone; the confirmation mail arrives within 2 minutes; sender
      shows as "AFFLUX <…@affluxseminar.org>"; headers show SPF pass, DKIM pass, DMARC pass.
- [ ] Open the link on the phone → "Continue" → returned to the page you came from.
- [ ] Open the same link again → "This link no longer works".
- [ ] Before opening a link: Join and Recording pages show the gate, never a Zoom address.
- [ ] Sign in with mailbox A from the computer (new device) → link → Continue → account page.
- [ ] Sign in with an address that never registered → link → "Complete your registration" form.
- [ ] Register from Russia with a Mail.ru address; mail arrives and is not in spam (note where it lands).
- [ ] Wrong email format, empty name: the form shows the error, nothing is sent.
- [ ] Six sign-in requests in a row for one address: the fifth is refused with "Too many attempts".
- [ ] Open a sign-in link in a different browser than the one that asked: the page warns about it
      and names the account (masked); while signed in as A, a link for B is refused.

## Programme editor
- [ ] Admin → Programme → New talk: publish a test talk with a photo and a PDF; the commit appears in
      the content repository under the token's name; the talk is on the site within the hour (sooner after a manual "Run workflow")
      with the photo and the slides link; the Join button shows because a Zoom link was entered.
- [ ] Edit it: change the title, leave the Zoom field empty → the stored link survives (Join still
      works); tick "Remove the stored Zoom link" → the Join button disappears after the rebuild.
- [ ] Open the same talk in two tabs, save in one, then in the other → refused as changed meanwhile.
- [ ] Delete the test talk → gone from the site after the rebuild; the photo file stays in the repository.

## Protected links
- [ ] Admin: enter a Zoom link and a YouTube link for a test talk.
- [ ] A past talk with `slides` and `minutes` set to files in `files/`: both open from the archive row
      and from the talk page, on the phone too.
- [ ] Signed-in: Join opens Zoom; Recording opens YouTube; both from phone and computer.
- [ ] Signed-out (private window): both show the gate.
- [ ] Talk without links: "Not available yet".

## Account
- [ ] Change name, toggle both lists, Save → "Saved.", values persist after reload.
- [ ] Comments and suggestions: send a message from the phone; it arrives at the seminar address
      with the participant's name and a working Reply-To; a sixth message within an hour is refused.
- [ ] Sign out → Join shows the gate again. Sign in again works.
- [ ] Sign out on all devices from the computer → phone is signed out too.
- [ ] Delete account → gate again; registering the same address again works from scratch.

## Announcements
- [ ] Two test accounts on the RU list, one on the EN list. Admin → Announce (RU): preview shows 2
      recipients; confirm → the job page shows "Start sending" and nothing has been sent; press Start;
      both mails arrive; the EN account gets nothing.
- [ ] Close the progress page mid-send on a larger list and reopen it: it resumes from where it was,
      no duplicate mail.
- [ ] Mail shows the seminar sender, the RU footer and an unsubscribe link; headers carry
      List-Unsubscribe.
- [ ] Click the unsubscribe link → confirmation page → confirm; the account page shows the list off.
- [ ] Send again → only the remaining recipient gets it.
- [ ] "Announce this session" prefills subject and text in the talk's language.

## Admin and operations
- [ ] /admin without being signed in through Cloudflare Access → 403.
- [ ] Access sign-in requires the second factor.
- [ ] Nightly job: a registration left unconfirmed for a day disappears (check the next morning).
- [ ] Cloudflare rate-limiting rule covers /api/* and /ru/api/* (dashboard shows it).
- [ ] Logs: request a sign-in link, then search every log surface in the Cloudflare dashboard for the
      token's first characters — Workers Logs must be off and show nothing; no Logpush job exists.
- [ ] Two SMTP2GO API keys in use (sign-in mail and announcements), each "send only", 2FA on the account.
- [ ] Key rotation rehearsal on staging: set INDEX_KEY/DATA_KEY with _PREVIOUS, run Reindex and
      Re-encrypt until both counters on the maintenance page are 0, remove _PREVIOUS, sign in again
      and open the admin overview (announcements must still decrypt).
- [ ] Query budget: run a 20-recipient chunk and a 100-row migration pass on the real plan; no
      "too many subrequests/queries" error in the Worker's error view.
- [ ] Access: a request to /admin from a browser not signed in through Access is refused; the
      staging and production Access applications are separate; /ru/api/* is covered by the WAF rule.
- [ ] D1 databases are in the intended region; their tables contain no readable name or address.

## Site content
- [ ] EN and RU switch keeps you on the same page.
- [ ] Three appearances switch instantly and persist after reload.
- [ ] A talk with `join: true` shows Join until the session ends and Recording afterwards.
- [ ] "Fig. 1" is still (no animation) when the system's "reduce motion" is on.
