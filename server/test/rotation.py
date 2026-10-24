"""Key-rotation rehearsal against the local Worker: seeds N identities under the current keys,
rotates INDEX_KEY and DATA_KEY (old values kept as *_PREVIOUS), checks that the key-generation fence
refuses a writer still on the old generation, migrates through the admin until both counters are 0,
verifies every row, removes the previous keys and checks sign-in still works. Restarts `wrangler dev`
itself and DELETES ALL LOCAL DATA when done — run it only against a disposable local database:
    python3 test/rotation.py --disposable [N]     (default N = 600). Exits 1 on failure."""
import os, sys, json, time, base64, subprocess, urllib.request, re, signal
if '--disposable' not in sys.argv: raise SystemExit('refusing to run: this rehearsal wipes the local databases; pass --disposable')
args=[a for a in sys.argv[1:] if not a.startswith('--')]; N=int(args[0]) if args else 600
CWD=os.path.dirname(os.path.dirname(os.path.abspath(__file__))); B='http://localhost:8788'; M='http://127.0.0.1:9101'
out=[]
def ok(c,m): out.append(('PASS' if c else 'FAIL')+' '+m)
def sh(cmd, **kw): return subprocess.run(cmd, cwd=CWD, capture_output=True, text=True, **kw)
def d1(db, sql=None, file=None):
    args=['npx','wrangler','d1','execute',db,'--local','--env','dev','--json']+(['--file',file] if file else ['--command',sql])
    r=sh(args); 
    if r.returncode!=0: raise SystemExit('d1 failed: '+r.stderr[-400:])
    return json.loads(r.stdout[r.stdout.index('['):])[0]['results']   # wrangler may print a notice before the JSON
def restart():
    subprocess.run(['pkill','-f','[w]orkerd']); time.sleep(1)
    subprocess.Popen(['npx','wrangler','dev','--env','dev','--local','--port','8788','--test-scheduled'], cwd=CWD, stdout=open('/tmp/wrangler-rot.log','w'), stderr=subprocess.STDOUT, start_new_session=True)
    for _ in range(40):
        time.sleep(1)
        try:
            if urllib.request.urlopen(B+'/api/health', timeout=2).status==200: return
        except Exception: pass
    raise SystemExit('worker did not start')
def vars_get():
    return dict(l.split('=',1) for l in open(os.path.join(CWD,'.dev.vars.dev')).read().splitlines() if '=' in l and not l.startswith('#'))
def vars_set(d):
    open(os.path.join(CWD,'.dev.vars.dev'),'w').write('\n'.join(f'{k}={v}' for k,v in d.items())+'\n')
def maint(action):
    req=urllib.request.Request(B+'/admin/maintenance', data=f'action={action}'.encode(), method='POST', headers={'Origin':B}); t=urllib.request.urlopen(req).read().decode()
    m=re.search(r'Rows not yet on the current INDEX_KEY</dt><dd>(\d+).*?current DATA_KEY \(all stores\)</dt><dd>(\d+)', t, re.S); return int(m.group(1)), int(m.group(2))
def signin(email):
    urllib.request.urlopen(M+'/_reset').read()
    req=urllib.request.Request(B+'/api/signin', data=f'email={email}&lang=en'.encode(), method='POST', headers={'Origin':B}); urllib.request.urlopen(req).read()
    return json.loads(urllib.request.urlopen(M+'/_outbox').read())[0]['subject']
backup=open(os.path.join(CWD,'.dev.vars.dev')).read()
try:
    # 1. seed under the current ("old") keys
    sh(['node','test/seed-identities.mjs',str(N),'/tmp/seed-identity.sql','/tmp/seed-users.sql'])
    d1('afflux_identity', file='/tmp/seed-identity.sql'); d1('afflux_users', file='/tmp/seed-users.sql')
    d1('afflux_users', "DELETE FROM throttle")
    total=d1('afflux_identity',"SELECT COUNT(*) n FROM identities")[0]['n']; ok(total>=N, f'{total} identities seeded')
    # 2. rotate both keys, keep old as previous
    v=vars_get(); old_i, old_d = v['INDEX_KEY'], v['DATA_KEY']
    v['INDEX_KEY']=base64.b64encode(os.urandom(32)).decode(); v['DATA_KEY']=base64.b64encode(os.urandom(32)).decode(); v['INDEX_KEY_PREVIOUS']=old_i; v['DATA_KEY_PREVIOUS']=old_d
    vars_set(v); restart()
    ok(signin('seed7@example.org')=='Your EEES sign-in link', 'lookup through INDEX_KEY_PREVIOUS finds a seeded identity (sign-in, not registration)')
    # the first WRITE of the new generation advances the fence (here: the first migration pass); from then on a
    # writer still on the old generation is refused — so "0 remaining" can never be followed by an old-key write
    maint('reencrypt')
    fence=d1('afflux_users', "SELECT value FROM meta WHERE key='data_key_fp'")[0]['value']
    import hashlib
    ok(fence==base64.urlsafe_b64encode(hashlib.sha256(base64.b64decode(v['DATA_KEY'])).digest()).decode().rstrip('=')[:8], 'fence advanced to the new DATA_KEY generation automatically')
    oldenv={**v, 'DATA_KEY': old_d, 'INDEX_KEY': old_i}; oldenv.pop('DATA_KEY_PREVIOUS'); oldenv.pop('INDEX_KEY_PREVIOUS')
    r=subprocess.run(['node','-e', '''
      const fs=require("fs"); (async()=>{ const c=await import("./src/crypto.js"); const f=await import("./src/fence.js");
      const env=JSON.parse(process.argv[1]);
      const db={ prepare:(sql)=>({ bind:(...a)=>({ first:async()=>({value:process.argv[2]}), run:async()=>({meta:{changes:0}}) }) }) };
      try { await f.dataFence(env, db); console.log("ALLOWED"); } catch(e){ console.log(e.code); } })();
    ''', json.dumps(oldenv), fence], cwd=CWD, capture_output=True, text=True)
    ok('E_KEY_GENERATION' in r.stdout, f'an old-generation writer is refused by the fence ({r.stdout.strip()})')
    # 3. migrate until both counters report 0; the index counter must count the un-migrated tail exactly
    i_rem, e_rem = maint('reindex'); passes=1
    while i_rem>0 and passes<50: i_rem,_=maint('reindex'); passes+=1
    ok(i_rem==0 and passes>=N//100, f'reindex reached 0 after {passes} passes (N={N})')
    e_passes=1; _, e_rem = maint('reencrypt')
    while e_rem>0 and e_passes<80: _,e_rem=maint('reencrypt'); e_passes+=1
    ok(e_rem==0, f're-encrypt reached 0 after {e_passes} passes (addresses, profiles, announcements, links)')
    # 4. verify every row directly: no email_key / ciphertext under an old fingerprint
    fp=lambda key: base64.urlsafe_b64encode(__import__('hashlib').sha256(base64.b64decode(key)).digest()).decode().rstrip('=')[:8]
    rows=d1('afflux_identity', f"SELECT COUNT(*) n FROM identities WHERE substr(email_key,1,9) != '{fp(v['INDEX_KEY'])}.' OR substr(email_enc,1,9) != '{fp(v['DATA_KEY'])}.'")[0]['n']
    ok(rows==0, 'every identity row is on the new index key and the new data key')
    rows=d1('afflux_users', f"SELECT COUNT(*) n FROM users WHERE substr(name_enc,1,9) != '{fp(v['DATA_KEY'])}.'")[0]['n']; ok(rows==0, 'every profile is under the new data key')
    # 5. remove the previous keys: everything must keep working on the new keys alone
    del v['INDEX_KEY_PREVIOUS']; del v['DATA_KEY_PREVIOUS']; vars_set(v); restart(); d1('afflux_users', "DELETE FROM throttle")
    ok(signin('seed599@example.org' if N>599 else 'seed1@example.org')=='Your EEES sign-in link', 'after removing previous keys, the last seeded identity is still found (no duplicate created)')
    ok(d1('afflux_identity',"SELECT COUNT(*) n FROM identities")[0]['n']==total, 'identity count unchanged through the rotation')
finally:
    open(os.path.join(CWD,'.dev.vars.dev'),'w').write(backup)
    # disposable data: wipe everything the rehearsal touched, including the fence, so the restored keys start clean
    for db,sql in [('afflux_identity',"DELETE FROM identities; DELETE FROM tokens; DELETE FROM sessions; DELETE FROM meta;"),('afflux_users',"DELETE FROM users; DELETE FROM pending_profiles; DELETE FROM throttle; DELETE FROM sends; DELETE FROM send_targets; DELETE FROM meta;"),('afflux_links',"DELETE FROM links; DELETE FROM meta;")]:
        try: d1(db, sql)
        except SystemExit: pass
    restart()
print('\n'.join(out)); fails=sum(1 for o in out if o.startswith('FAIL')); print('FAILS:', fails); sys.exit(1 if fails else 0)
