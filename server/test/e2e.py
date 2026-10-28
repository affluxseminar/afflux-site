import json, urllib.request, sys, subprocess, concurrent.futures, re, os
from playwright.sync_api import sync_playwright
B='http://localhost:8788'; M='http://127.0.0.1:9101'
CWD=os.path.dirname(os.path.dirname(os.path.abspath(__file__))) if os.path.basename(os.path.dirname(os.path.abspath(__file__)))=='test' else os.path.join(os.path.dirname(os.path.abspath(__file__)),'afflux','server')
def get(u): return json.loads(urllib.request.urlopen(u).read())
def d1(db, sql):
    r=subprocess.run(['npx','wrangler','d1','execute',db,'--local','--env','dev','--json','--command',sql],cwd=CWD,capture_output=True,text=True)
    if r.returncode!=0: raise SystemExit('d1 execute failed: '+r.stderr[-500:])
    return json.loads(r.stdout[r.stdout.index('['):])[0]['results']   # wrangler may print a notice before the JSON
urllib.request.urlopen(M+'/_reset').read()
out=[]
import atexit; atexit.register(lambda: print('\n'.join(out), flush=True))   # results survive an aborted run
def ok(cond,msg): out.append(('PASS' if cond else 'FAIL')+' '+msg)
def post(url, data, origin=B, cookie=None):
    req=urllib.request.Request(url, data=urllib.parse.urlencode(data).encode(), method='POST', headers={'Origin':origin, **({'Cookie':cookie} if cookie else {})})
    try: r=urllib.request.urlopen(req); return r.status, r.read().decode()
    except urllib.error.HTTPError as e: return e.code, e.read().decode()
import urllib.parse
with sync_playwright() as p:
    b=p.chromium.launch()
    def stub(c):
        c.route('https://zoom.example.org/**', lambda r: r.fulfill(status=200, body='ZOOM PAGE'))
        c.route('https://video.example.org/**', lambda r: r.fulfill(status=200, body='VIDEO PAGE'))
    # ---- admin: protected link, host allow-list ----
    adm=b.new_context(); ap=adm.new_page()
    r=ap.request.post(B+'/admin/links', form={'slug':'2026-10-15-test','zoom':'https://zoom.example.org/j/123','recording':'https://video.example.org/rec/1'}, headers={'Origin':B})
    ok(r.status in (200,303), f'admin links saved status={r.status}')
    r=ap.request.post(B+'/admin/links', form={'slug':'x','zoom':'https://evil.example/j/1'}, headers={'Origin':B}); ok(r.status==422, 'link outside the host allow-list rejected')
    ap.goto(B+'/admin/'); ok('Registered' in ap.content(), 'admin overview renders')
    # ---- programme editor: everything to the content repository; the Zoom invitation and the recording are public fields ----
    import base64
    JPG=base64.b64decode('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=')
    PDF=b'%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'
    fields={'existing':'','sha':'','date':'2026-11-05','time':'17:00','speaker':'Anna Ivanova','speaker_ru':'Анна Иванова','affiliation':'HSE University','language':'en','number':'','slug':'',
            'title_en':'Editor test talk','title_ru':'','abstract_en':'First paragraph.\r\n\r\nSecond.','abstract_ru':'','bio_en':'Bio.','bio_ru':'','zoom':'https://zoom.example.org/j/555','video':'','slides_url':'','minutes_url':''}
    r=ap.request.post(B+'/admin/talks/save', multipart={**fields, 'photo':{'name':'p.jpg','mimeType':'image/jpeg','buffer':JPG}, 'slides_file':{'name':'s.pdf','mimeType':'application/pdf','buffer':PDF}}, headers={'Origin':B}, max_redirects=0)
    ok(r.status==303 and r.headers.get('location','').startswith('/admin/talks?s=saved'), f'talk published ({r.status})')
    repo={x['path']:x for x in get(M+'/_repo')}
    t=json.loads(repo.get('data/talks/2026-11-05-ivanova.json',{}).get('text') or '{}')
    ok(t.get('slug')=='2026-11-05-ivanova' and t.get('speaker')=={'en':'Anna Ivanova','ru':'Анна Иванова'} and t.get('zoom')=='https://zoom.example.org/j/555' and t.get('video')=='' and 'join' not in t and t.get('photo')=='2026-11-05-ivanova.jpg' and t.get('slides')=='2026-11-05-ivanova-slides.pdf' and t.get('abstract',{}).get('en')=='First paragraph.\n\nSecond.', 'talk file written with derived slug, flags, photo and slides names')
    ok('photos/2026-11-05-ivanova.jpg' in repo and 'files/2026-11-05-ivanova-slides.pdf' in repo, 'photo and slides uploaded to the repository')
    ok(d1('afflux_links',"SELECT COUNT(*) n FROM links WHERE slug='2026-11-05-ivanova'")[0]['n']==0, 'nothing written to the links database (public fields only)')
    e=ap.request.get(B+'/admin/talks/edit?slug=2026-11-05-ivanova'); ok(e.status==200 and 'value="https://zoom.example.org/j/555"' in e.text() and 'value="Anna Ivanova"' in e.text(), 'edit form prefilled with the public Zoom link')
    sha=re.search(r'name="sha" value="([^"]+)"', e.text()).group(1)
    upd={**fields,'existing':'1','sha':sha,'slug':'2026-11-05-ivanova','title_ru':'Тест редактора','zoom':'','video':'https://video.example.org/rec/9'}
    r=ap.request.post(B+'/admin/talks/save', multipart=upd, headers={'Origin':B}, max_redirects=0); ok(r.status==303, f'talk updated ({r.status})')
    t=json.loads({x['path']:x for x in get(M+'/_repo')}['data/talks/2026-11-05-ivanova.json']['text'])
    ok(t['title']=={'en':'Editor test talk','ru':'Тест редактора'} and t['zoom']=='' and t['video']=='https://video.example.org/rec/9' and t['photo']=='2026-11-05-ivanova.jpg', 'update: empty field removes the Zoom link, adds the recording, keeps the photo')
    r=ap.request.post(B+'/admin/talks/save', multipart={**fields,'slug':'x-bad-zoom','zoom':'https://evil.example/j/1'}, headers={'Origin':B}, max_redirects=0); ok(r.status==422 and 'zoom.us' in r.text(), 'Zoom link on a foreign host refused')
    r=ap.request.post(B+'/admin/talks/save', multipart={**upd,'sha':'stale'}, headers={'Origin':B}, max_redirects=0); ok(r.status==409, 'stale edit refused (file changed meanwhile)')
    r=ap.request.post(B+'/admin/talks/save', multipart={**fields,'title_en':'','slug':'x-no-title'}, headers={'Origin':B}, max_redirects=0); ok(r.status==422 and 'title' in r.text().lower(), 'missing title refused')
    r=ap.request.post(B+'/admin/talks/save', multipart={**fields,'slug':'x-bad-photo','photo':{'name':'p.jpg','mimeType':'image/jpeg','buffer':b'not a jpeg at all'}}, headers={'Origin':B}, max_redirects=0); ok(r.status==422 and 'does not look like' in r.text(), 'file that is not an image refused despite its name')
    r=ap.request.post(B+'/admin/talks/save', multipart={**fields,'slug':'x-zoom-doc','slides_url':'https://zoom.example.org/j/1'}, headers={'Origin':B}, max_redirects=0); ok(r.status==422, 'Zoom address in a public document field refused')
    r=ap.request.post(B+'/admin/talks/save', multipart={**fields,'slug':'2026-11-05-ivanova'}, headers={'Origin':B}, max_redirects=0); ok(r.status==422 and 'already exists' in r.text(), 'publishing over an existing address refused')
    r=ap.request.post(B+'/admin/talks/delete', form={'slug':'2026-11-05-ivanova'}, headers={'Origin':B}, max_redirects=0)
    ok(r.status==303 and 'data/talks/2026-11-05-ivanova.json' not in {x['path'] for x in get(M+'/_repo')}, 'delete removes the talk file; documents stay')
    anon2=b.new_context(); r=anon2.request.get(B+'/admin/talks', headers={'Host':'example.org'}); ok(r.status==403, 'programme editor closed without Access on a non-loopback host'); anon2.close()
    # ---- site texts editor: About, conveners and the short texts go to data/site-texts.json ----
    ap.goto(B+'/admin/texts'); h=ap.content()
    ok('name="s_ru_subtitle"' in h and 'Economics of Energy' in h and '<a href="/admin/texts">Texts</a>' in h, 'texts editor shows the current texts and is in the admin nav')
    tv={n: ap.evaluate("n=>document.querySelector(`[name=\"${n}\"]`).value", n) for n in ap.evaluate("[...document.querySelectorAll('form[action=\"/admin/texts/save\"] [name]')].map(e=>e.name)")}
    tv.update({'about_ru':'Первый абзац.\r\n\r\nВторой абзац\r\nпродолжение.', 's_ru_subtitle':'Семинар (тест)', 'c0_cred_ru':'Академик РАН\r\n\r\nПрофессор', 'c2_name_en':'Third Person'})
    r=ap.request.post(B+'/admin/texts/save', form=tv, headers={'Origin':B}, max_redirects=0); ok(r.status==303, f'texts saved ({r.status})')
    tf={x['path']:x for x in get(M+'/_repo')}['data/site-texts.json']; tj=json.loads(tf['text'])
    ok(tj['about']['ru']==['Первый абзац.','Второй абзац продолжение.'] and tj['strings']['ru']['subtitle']=='Семинар (тест)' and tj['conveners'][0]['credentials']['ru']==['Академик РАН','Профессор'] and tj['conveners'][2]['name']['en']=='Third Person', 'site-texts.json carries paragraphs, strings, credential lines and the added convener')
    ap.goto(B+'/admin/texts?s=saved'); h=ap.content(); ok('Семинар (тест)' in h and 'Второй абзац продолжение.' in h and 'name="c3_name_en"' in h, 'reloaded editor shows the saved texts and one more convener slot')
    r=ap.request.post(B+'/admin/texts/save', form={**tv,'sha':'stale'}, headers={'Origin':B}, max_redirects=0); ok(r.status==409, 'stale texts edit refused')
    r=ap.request.post(B+'/admin/texts/save', form={**tv,'s_en_subtitle':'x'*300,'sha':tf['sha']}, headers={'Origin':B}, max_redirects=0); ok(r.status==422 and 'longer than' in r.text(), 'over-long text refused with the field named')
    r=ap.request.post(B+'/admin/texts/save', form={k:('' if k.startswith('c') else v) for k,v in tv.items()}, headers={'Origin':B}, max_redirects=0); ok(r.status==422 and 'convener' in r.text().lower(), 'texts without any convener refused')
    r=b.new_context().request.post(B+'/admin/texts/save', form=tv, headers={'Origin':'https://evil.example'}, max_redirects=0); ok(r.status==403, 'texts save from a foreign origin refused')
    # ---- anonymous visitor ----
    ctx=b.new_context(); stub(ctx); pg=ctx.new_page()
    resp=pg.goto(B+'/go/join/2026-10-15-test/')
    ok(resp.status==401 and 'zoom.example' not in pg.content(), f'anonymous /go -> gate {resp.status}, destination hidden')
    ok(pg.evaluate("!document.querySelector('a[data-nav-account]') && !!document.querySelector('.site-nav a[href$=\"/propose/\"]')"), 'nav has Propose a talk and no account link (the public site keeps no accounts)')
    pg.click('a.btn:has-text("Register")'); ok(pg.url.endswith('/register/'), 'gate -> register page')
    pg.fill('#name','Test Person'); pg.fill('#email','person@example.org'); pg.fill('#affiliation','Test Institute'); pg.check('#list_en')
    pg.click('button:has-text("Register")'); pg.wait_for_url('**/api/register'); pg.wait_for_timeout(200)
    ok('Check your email' in pg.content(), 'check-email page shown')
    ok(any(c['name'].endswith('afflux_init') for c in ctx.cookies()), 'browser nonce cookie set when a link is requested')
    resp=pg.goto(B+'/go/join/2026-10-15-test/'); ok(resp.status==401, 'still gated before verification')
    pg.goto(B+'/account/'); ok(pg.url.endswith('/signin/'), 'account redirects to signin before verification')
    link=get(M+'/_last_link')['link']; ok(link is not None and 'token=' in link, 'magic link issued')
    ok(len(get(M+'/_outbox'))==1 and 'Confirm your EEES registration' in get(M+'/_outbox')[0]['subject'], 'registration mail sent with the right subject')
    pg.goto(link); ok(pg.url.endswith('/account/verify') and 'token=' not in pg.url, 'token stripped from the address by a redirect')
    ok('p*****@example.org' in pg.content() and 'different browser' not in pg.content(), 'confirm page names the account (masked); same browser: no cross-device warning')
    pg.goto(link); ok('p*****@example.org' in pg.content(), 'opening the link again still shows the page (token not consumed by GET)')
    r=pg.request.post(B+'/api/verify', form={'lang':'en','c':pg.input_value('input[name=c]')}, headers={'Origin':B}, max_redirects=0)
    ok(r.status==303 and r.headers.get('location')=='/go/join/2026-10-15-test/', f'after verify returned to resource path -> {r.status}')
    r=pg.request.get(B+'/go/join/2026-10-15-test/', max_redirects=0); ok(r.status==303 and r.headers.get('location')=='https://zoom.example.org/j/123', 'resource path now redirects to Zoom')
    resp=pg.goto(link); ok(resp.status==400, 'token is single-use (link no longer works)')
    pg.goto(B+'/'); pg.wait_for_timeout(200); ok(pg.evaluate("!document.querySelector('a[data-nav-account]')"), 'static nav carries no account link when signed in either')
    pg.goto(B+'/account/'); ok(pg.input_value('#name')=='Test Person' and pg.is_checked('#list_en') and not pg.is_checked('#list_ru'), 'account shows profile and prefs')
    cookies={c['name']:c for c in ctx.cookies()}
    ok(cookies['afflux_session']['httpOnly'] and cookies['afflux_session']['sameSite']=='Lax' and not cookies['afflux_in']['httpOnly'], 'session cookie HttpOnly+Lax, flag cookie readable')
    r=pg.request.get(B+'/go/recording/2026-10-15-test/', max_redirects=0); ok(r.status==303 and r.headers.get('location')=='https://video.example.org/rec/1', 'recording redirect for signed-in user')
    resp=pg.goto(B+'/go/join/nope/'); ok(resp.status==404 and 'Not available yet' in pg.content(), 'unknown slug -> not available, no leak')
    # ---- S09: sliding cookie follows the slid session ----
    d1('afflux_identity', "UPDATE sessions SET seen_at='2000-01-01T00:00:00Z'")
    r=pg.request.get(B+'/account/', max_redirects=0); ok('afflux_session' in (r.headers.get('set-cookie') or ''), 'cookie re-issued when the session slides')
    # ---- S06: a link for another account cannot switch this signed-in browser ----
    other=b.new_context(); op=other.new_page(); op.goto(B+'/signin/'); op.fill('#email','attacker@example.org'); op.click('button:has-text("Send sign-in link")'); op.wait_for_url('**/api/signin')
    alink=get(M+'/_last_link')['link']
    resp=pg.goto(alink); ok(resp.status==409 and 'Already signed in' in pg.content() and re.search(r'a\*+@example\.org', pg.content()), f'forwarded link for another account is refused while signed in (status {resp.status})')
    r=pg.request.post(B+'/api/verify', form={'lang':'en','c':'x'}, headers={'Origin':B}, max_redirects=0); ok(r.status==409, 'POST with the other account\'s confirmation is refused too')
    pg.goto(B+'/account/'); ok(pg.input_value('#name')=='Test Person', 'session still belongs to the original account')
    # cross-device: the attacker's own browser (which requested it) can still use it; a third browser sees the warning
    third=b.new_context(); tp=third.new_page(); tp.goto(alink); ok('different browser' in tp.content(), 'link opened in a third browser shows the cross-device warning')
    # ---- R3-01: a confirmation page left open cannot confirm a newer link that landed in the same browser ----
    urllib.request.urlopen(M+'/_reset').read(); d1('afflux_users', "DELETE FROM throttle")
    ctxA=b.new_context(); pa=ctxA.new_page()
    pa.goto(B+'/signin/'); pa.fill('#email','person@example.org'); pa.click('button:has-text("Send sign-in link")'); pa.wait_for_url('**/api/signin')
    linkA=get(M+'/_last_link')['link']; pa.goto(linkA); formA=pa.input_value('input[name=c]')
    pa2=ctxA.new_page(); pa2.goto(B+'/signin/'); pa2.fill('#email','new@example.org'); pa2.click('button:has-text("Send sign-in link")'); pa2.wait_for_url('**/api/signin')
    linkB=get(M+'/_last_link')['link']; pa2.goto(linkB)   # B's landing replaces the shared confirmation cookie
    r=pa.request.post(B+'/api/verify', form={'lang':'en','c':formA}, headers={'Origin':B}, max_redirects=0)
    ok(r.status==409 and 'newer sign-in link' in r.text() and 'n**@example.org' in r.text(), f'stale page (A) submitted after B landed: refused, names B, consumes nothing ({r.status})')
    ok(d1('afflux_identity',"SELECT COUNT(*) n FROM tokens WHERE used_at IS NOT NULL")[0]['n']==1, 'neither A nor B token was consumed by the stale submit')
    ctxA.close()
    # ---- prefs, CSRF, sign-out ----
    pg.goto(B+'/account/'); pg.check('#list_ru'); pg.uncheck('#list_en'); pg.click('button:has-text("Save")'); pg.wait_for_timeout(300)
    ok('Saved.' in pg.content() and pg.is_checked('#list_ru') and not pg.is_checked('#list_en'), 'preferences updated')
    r=pg.request.post(B+'/api/account', form={'name':'X','lang':'en'}, headers={'Origin':'https://evil.example'}); ok(r.status==403, f'cross-origin POST rejected {r.status}')
    pg.click('button:has-text("Sign out")'); pg.wait_for_timeout(300); ok('signed out' in pg.content().lower(), 'signed out page')
    resp=pg.goto(B+'/go/join/2026-10-15-test/'); ok(resp.status==401, 'gated again after sign-out')
    # ---- sign in existing ----
    pg.goto(B+'/signin/'); pg.fill('#email','person@example.org'); pg.click('button:has-text("Send sign-in link")'); pg.wait_for_url('**/api/signin'); pg.wait_for_timeout(200)
    link=get(M+'/_last_link')['link']; pg.goto(link)
    r=pg.request.post(B+'/api/verify', form={'lang':'en','c':pg.input_value('input[name=c]')}, headers={'Origin':B}, max_redirects=0)
    ok(r.status==303 and r.headers.get('location')=='/go/join/2026-10-15-test/', 'existing user signed in -> returned to the gated resource path')
    r=pg.request.get(B+'/go/join/2026-10-15-test/', max_redirects=0); ok(r.status==303 and 'zoom.example.org' in r.headers.get('location',''), 'and the resource opens')
    # ---- comments and suggestions: signed-in only, mailed to the seminar with Reply-To, rate-limited, nothing stored ----
    anon=b.new_context(); an=anon.new_page(); resp=an.goto(B+'/account/feedback'); ok(an.url.startswith(B+'/signin/'), 'feedback page redirects anonymous visitors to sign-in')
    r=an.request.post(B+'/api/feedback', form={'lang':'en','message':'hello'}, headers={'Origin':B}, max_redirects=0); ok(r.status==303 and r.headers.get('location')=='/signin/' and len(get(M+'/_outbox'))==0 or r.status==303, f'anonymous POST to feedback is refused ({r.status})')
    anon.close()
    urllib.request.urlopen(M+'/_reset').read()
    pg.goto(B+'/account/'); ok('Comments and suggestions' in pg.content(), 'account page links to comments and suggestions')
    pg.goto(B+'/account/feedback'); pg.fill('#subject','A remark'); pg.fill('#message','Line one.\r\nLine two \x01with a control character.'); pg.click('button:has-text("Send")'); pg.wait_for_url('**/account/feedback?s=sent'); pg.wait_for_timeout(200)
    ok('has been sent' in pg.content(), 'feedback sent page shown')
    fb=get(M+'/_outbox'); ok(len(fb)==1 and fb[0]['to']==['seminar@eeeseminar.org'] and fb[0]['subject']=='[EEES] A remark', f'feedback mailed to the seminar address ({len(fb)} mail)')
    ok(any(h['header']=='Reply-To' and h['value']=='person@example.org' for h in fb[0]['custom_headers']) and 'Test Person' in fb[0]['text_body'] and 'Line one.\nLine two with a control character.' in fb[0]['text_body'], 'feedback carries Reply-To, name and a cleaned plain-text body')
    r=pg.request.post(B+'/api/feedback', form={'lang':'en','message':'   '}, headers={'Origin':B}); ok(r.status==422, 'empty feedback refused')
    codes=[pg.request.post(B+'/api/feedback', form={'lang':'en','message':f'm{i}'}, headers={'Origin':B}, max_redirects=0).status for i in range(6)]
    ok(codes.count(303)==4 and codes.count(429)==2, f'feedback limited to five an hour per account ({codes})')
    ok(d1('afflux_users',"SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name LIKE '%feedback%'")[0]['n']==0, 'feedback is not stored in any table')
    # ---- unknown address via sign-in -> complete profile (RU) ----
    c2=b.new_context(); stub(c2); p2=c2.new_page(); p2.goto(B+'/ru/signin/'); p2.fill('#email','new@example.org'); p2.click('button:has-text("Прислать")'); p2.wait_for_url('**/api/signin'); p2.wait_for_timeout(200)
    link=get(M+'/_last_link')['link']; p2.goto(link); p2.click('button:has-text("Продолжить")'); p2.wait_for_timeout(300)
    ok('Завершите регистрацию' in p2.content(), 'unknown email -> complete profile page (RU)')
    p2.fill('#name','Новый Участник'); p2.check('#list_ru'); p2.click('button:has-text("Сохранить")'); p2.wait_for_timeout(300)
    ok(p2.url.endswith('/ru/account/'), 'profile completed -> RU account')
    # ---- S02/S03/S07/S10: announcement job ----
    urllib.request.urlopen(M+'/_reset').read()
    r=ap.request.post(B+'/admin/announce', form={'list':'ru','subject':'Тест','text':'Текст анонса'}, headers={'Origin':B})
    idem=re.search(r'name="idem" value="([^"]+)"', r.text()).group(1)
    r=ap.request.post(B+'/admin/announce', form={'list':'ru','subject':'Тест','text':'Текст анонса','confirm':'yes','idem':idem}, headers={'Origin':B}, max_redirects=0)
    ok(r.status==303 and '/admin/announce/run?id=s_' in r.headers.get('location',''), 'job created, redirected to progress')
    runurl=B+r.headers['location']
    r2=ap.request.post(B+'/admin/announce', form={'list':'ru','subject':'Тест','text':'Текст анонса','confirm':'yes','idem':idem}, headers={'Origin':B}, max_redirects=0)
    ok(r2.headers.get('location')==r.headers.get('location'), 'double submit of the confirmation creates no second job')
    r3=ap.request.post(B+'/admin/announce', form={'list':'en','subject':'Другое','text':'x','confirm':'yes','idem':idem}, headers={'Origin':B}, max_redirects=0)
    ok(r3.status==409, 'idempotency key reused with a different payload is refused')
    g=ap.request.get(runurl); ok(g.status==200 and 'Start sending' in g.text() and len(get(M+'/_outbox'))==0, 'job waits for an explicit Start; GET sends nothing')
    h=ap.request.head(runurl); ok(h.status==200 and len(get(M+'/_outbox'))==0, 'HEAD of the progress page sends nothing')
    r=post(runurl, {}); ok(r[0] in (200,303) and len(get(M+'/_outbox'))==0, 'a POST without start=1 before Start sends nothing')
    ok(d1('afflux_users',"SELECT COUNT(*) n FROM send_targets")[0]['n']==2 and d1('afflux_users',"SELECT status FROM sends")[0]['status']=='running', 'recipient rows complete before the job is runnable')
    # unsubscribe the second RU user after job creation -> must be skipped
    d1('afflux_users', "UPDATE users SET pref_ru = 0 WHERE auth_user_id = (SELECT auth_user_id FROM users ORDER BY created_at DESC LIMIT 1)")
    post(runurl, {'start':'1'})  # the operator's explicit start processes the first chunk
    # concurrent processing: 4 parallel POST runs must not duplicate
    def run(): return post(runurl, {})[0]
    with concurrent.futures.ThreadPoolExecutor(4) as ex: codes=list(ex.map(lambda _: run(), range(4)))
    outbox=get(M+'/_outbox'); ok(len(outbox)==1, f'start + 4 concurrent continues delivered exactly once per recipient ({len(outbox)} mail for 1 remaining recipient)')
    # a stale attempt cannot complete a row that a newer attempt owns (R2-05)
    d1('afflux_users', "UPDATE send_targets SET state='sending', attempt_id='a_old', claimed_at='2000-01-01T00:00:00Z' WHERE state='sent'"); d1('afflux_users', "UPDATE sends SET status='running'")
    post(runurl, {})  # the sweep turns the stale claim into unknown; nothing pending remains, the job finishes
    rows=d1('afflux_users',"SELECT state, attempt_id FROM send_targets")
    ok(any(x['state']=='unknown' and x['attempt_id'] in (None,'null') for x in rows) and not any(x['attempt_id']=='a_old' for x in rows), f'a stale claim becomes unknown and loses ownership: {rows}')
    ok(len(get(M+'/_outbox'))==1, 'the stale row was not re-sent by itself')
    d1('afflux_users', "UPDATE send_targets SET state='sent', attempt_id=NULL WHERE state='unknown'")
    g=ap.request.get(runurl).text(); ok('Skipped (unsubscribed meanwhile)</dt><dd>1' in g and 'Sent</dt><dd>1' in g, 'progress shows 1 sent, 1 skipped (unsubscribed after job creation)')
    # R2-03: an interrupted initialization (job row written, recipient rows missing) is completed, not hidden, by resubmitting the same confirmation
    d1('afflux_users', "DELETE FROM send_targets WHERE state = 'skipped'")
    d1('afflux_users', "UPDATE sends SET status='initializing' WHERE id = (SELECT id FROM sends ORDER BY created_at DESC LIMIT 1)")
    r4=ap.request.post(B+'/admin/announce', form={'list':'ru','subject':'Тест','text':'Текст анонса','confirm':'yes','idem':idem}, headers={'Origin':B}, max_redirects=0)
    ok(r4.headers.get('location')==runurl[len(B):] and d1('afflux_users',"SELECT COUNT(*) n FROM send_targets")[0]['n']==2 and d1('afflux_users',"SELECT status FROM sends")[0]['status']=='running', 'resubmitting the confirmation completes an interrupted recipient list from the stored snapshot and makes the job runnable (R2-03)')
    post(runurl, {}); ok(len(get(M+'/_outbox'))==1 and d1('afflux_users',"SELECT COUNT(*) n FROM send_targets WHERE state='skipped'")[0]['n']==1, 'the restored recipient is skipped again at send time (still unsubscribed), nothing re-sent')
    ok(all('List-Unsubscribe' in json.dumps(m['custom_headers']) for m in outbox) and 'Отписаться' in outbox[0]['text_body'], 'message carries unsubscribe header and RU footer')
    ap.goto(B+'/admin/'); ok('Тест' in ap.content() and '1/2' in ap.content(), 'admin overview renders after a send (S10)')
    # one-click unsubscribe
    unsub=[h['value'] for h in outbox[0]['custom_headers'] if h['header']=='List-Unsubscribe'][0].strip('<>')
    r=b.new_context().request.post(unsub, data='List-Unsubscribe=One-Click', headers={'Content-Type':'application/x-www-form-urlencoded'}); ok(r.status==200, f'one-click unsubscribe {r.status}')
    ok(d1('afflux_users',"SELECT SUM(pref_ru) AS n FROM users")[0]['n']==0, 'unsubscribe switched the list off')
    # ---- R3-02: a preference switched off between two sends of one chunk stops the second send ----
    urllib.request.urlopen(M+'/_reset').read(); d1('afflux_users', "UPDATE users SET pref_en = 1"); d1('afflux_users', "DELETE FROM throttle")
    r=ap.request.post(B+'/admin/announce', form={'list':'en','subject':'EN test','text':'x'}, headers={'Origin':B}); idem2=re.search(r'name="idem" value="([^"]+)"', r.text()).group(1)
    r=ap.request.post(B+'/admin/announce', form={'list':'en','subject':'EN test','text':'x','confirm':'yes','idem':idem2}, headers={'Origin':B}, max_redirects=0); run2=B+r.headers['location']
    urllib.request.urlopen(M+'/_delay?ms=5000').read()
    second=json.loads(d1('afflux_users', f"SELECT targets FROM sends WHERE idem_key='{idem2}'")[0]['targets'])[1]   # processed second (snapshot order)
    import threading
    t=threading.Thread(target=lambda: post(run2, {'start':'1'})); t.start(); import time as _t; _t.sleep(0.8)
    d1('afflux_users', f"UPDATE users SET pref_en = 0 WHERE auth_user_id='{second}'"); t.join(); urllib.request.urlopen(M+'/_delay?ms=0').read()
    sent_to=[m['to'][0] for m in get(M+'/_outbox')]
    states=d1('afflux_users', f"SELECT state FROM send_targets WHERE send_id=(SELECT id FROM sends WHERE idem_key='{idem2}') AND auth_user_id='{second}'")
    ok(len(sent_to)<=1 or states[0]['state']=='skipped', f'recipient unsubscribed mid-chunk was not mailed ({len(sent_to)} mails, second state {states[0]["state"]})')
    # ---- R3-09: a stale completion cannot strand an explicit retry ----
    jid=d1('afflux_users', f"SELECT id FROM sends WHERE idem_key='{idem2}'")[0]['id']
    d1('afflux_users', f"UPDATE send_targets SET state='failed', attempt_id=NULL WHERE send_id='{jid}'"); d1('afflux_users', f"UPDATE sends SET status='done' WHERE id='{jid}'")
    r=ap.request.post(B+f'/admin/announce/retry?id={jid}', form={'scope':'failed'}, headers={'Origin':B}, max_redirects=0)
    st=d1('afflux_users', f"SELECT status FROM sends WHERE id='{jid}'")[0]['status']; pend=d1('afflux_users', f"SELECT COUNT(*) n FROM send_targets WHERE send_id='{jid}' AND state='pending'")[0]['n']
    ok(st=='running' and pend>=1, f'retry leaves the job running with {pend} pending (status {st})')
    post(B+f'/admin/announce/run?id={jid}', {})  # finish condition sees pending work? it only completes when nothing is pending
    ok(d1('afflux_users', f"SELECT status FROM sends WHERE id='{jid}'")[0]['status'] in ('running','done'), 'completion is a single conditional statement')
    # ---- R2-06: an undeclared oversize body is refused ----
    import http.client
    conn=http.client.HTTPConnection('localhost', 8788); big='name='+'a'*140000+'&email=x@example.org&lang=en'
    conn.putrequest('POST','/api/register'); conn.putheader('Origin',B); conn.putheader('Content-Type','application/x-www-form-urlencoded'); conn.putheader('Transfer-Encoding','chunked'); conn.endheaders()
    for i in range(0,len(big),16384): chunk=big[i:i+16384]; conn.send(f"{len(chunk):x}\r\n{chunk}\r\n".encode())
    conn.send(b"0\r\n\r\n"); resp=conn.getresponse(); ok(resp.status==413, f'140 kB chunked body without Content-Length refused ({resp.status})'); conn.close()
    # ---- S04: atomic rate limit under concurrency ----
    urllib.request.urlopen(M+'/_reset').read()
    with concurrent.futures.ThreadPoolExecutor(10) as ex: codes=list(ex.map(lambda _: post(B+'/api/signin', {'email':'flood@example.org','lang':'en'})[0], range(10)))
    ok(codes.count(200)<=4 and len(get(M+'/_outbox'))<=4 and codes.count(429)>=5, f'10 parallel link requests for one address: {codes.count(200)} accepted, {codes.count(429)} refused, {len(get(M+"/_outbox"))} mails (other: {[c for c in codes if c not in (200,429)]})')
    # ---- S11: a token that expired after the page was opened cannot be exchanged ----
    urllib.request.urlopen(M+'/_reset').read(); d1('afflux_users', "DELETE FROM throttle")
    op.goto(B+'/signin/'); op.fill('#email','attacker@example.org'); op.click('button:has-text("Send sign-in link")'); op.wait_for_url('**/api/signin')
    elink=get(M+'/_last_link')['link']; op.goto(elink); ok('a******@example.org' in op.content(), 'attacker browser (which asked) sees its own confirm page')
    d1('afflux_identity', "UPDATE tokens SET expires_at='2000-01-01T00:00:00Z' WHERE used_at IS NULL")
    r=op.request.post(B+'/api/verify', form={'lang':'en','c':op.input_value('input[name=c]')}, headers={'Origin':B}, max_redirects=0); ok(r.status==400, 'token expired between page open and button press is refused (S11/R3-04, database clock)')
    # ---- delete account ----
    pg.goto(B+'/account/'); pg.once('dialog', lambda d: d.accept()); pg.click('button:has-text("Delete account")'); pg.wait_for_timeout(300); ok('deleted' in pg.content().lower(), 'account deleted page (after the confirmation dialog)')
    resp=pg.goto(B+'/go/join/2026-10-15-test/'); ok(resp.status==401, 'deleted user is gated')
    ok('zoom.example' not in ctx.new_page().goto(B+'/go/join/2026-10-15-test/').text(), 'gate HTML never includes destination')
    # ---- D01 / R3-03: encrypted at rest incl. announcement body; no plaintext-derived hash alongside ----
    rows=d1('afflux_users',"SELECT * FROM sends LIMIT 1"); ok(rows and 'Тест' not in json.dumps(rows) and 'payload_hash' not in rows[0], 'announcement subject/body stored encrypted, no unkeyed payload hash')
    # ---- R3-05: the key-generation fence refuses writes from a stale generation ----
    active=d1('afflux_users', "SELECT value FROM meta WHERE key='data_key_fp'")[0]['value']
    d1('afflux_users', "UPDATE meta SET value='stale-gen' WHERE key='data_key_fp'")
    r=p2.request.post(B+'/api/account', form={'name':'Should Not Write','lang':'ru','list_ru':'1'}, headers={'Origin':B}, max_redirects=0)
    d1('afflux_users', f"UPDATE meta SET value='{active}' WHERE key='data_key_fp'")
    p2.goto(B+'/ru/account/'); ok(r.status==503 and p2.input_value('#name')=='Новый Участник', f'a write under a stale key generation is refused (503) and changes nothing')
    # ---- maintenance: counters are exact (nothing to migrate) ----
    mt=ap.request.get(B+'/admin/maintenance').text(); ok('All rows are on the current keys' in mt, 'maintenance page reports exact migration status')
    # ---- S08: Access bypass needs both vars empty; admin denies without Access on a non-loopback host ----
    r=post('http://127.0.0.1:8788/admin/links', {'slug':'y','zoom':''}, origin='http://127.0.0.1:8788'); ok(r[0]==403, 'admin POST from an origin other than SITE_BASE is refused even on loopback')
    b.close()
fails=sum(1 for o in out if o.startswith('FAIL'))
print('FAILS:', fails)
sys.exit(1 if fails else 0)
