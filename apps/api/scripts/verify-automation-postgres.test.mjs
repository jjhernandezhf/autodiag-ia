// Explicit disposable-container validation. Never reads connection strings/env.
import { spawn } from 'node:child_process';
import { setTimeout, clearTimeout } from 'node:timers';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const container = 'autodiag-automation-pg-validation';
function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { shell: false, windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('HARNESS_TIMEOUT')); }, 15000);
    child.stdout.on('data', c => { out += c; }); child.stderr.on('data', c => { err += c; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, out: out.trim(), err }); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
}
async function sql(query, role = 'service_role', success = true) {
  const r = await run(['exec','-i',container,'psql','-X','-qAt','-U',role,'-d','autodiag_automation_test','-v','ON_ERROR_STOP=1'],
    `SET statement_timeout='5s'; SET lock_timeout='4s';\n${query}`);
  if (success) assert.equal(r.code, 0, r.err);
  else assert.notEqual(r.code, 0, 'Expected SQL rejection');
  return r;
}
const id = n => `automation_v1_${n.toString(16).padStart(64,'0')}`;
const call = (n,op) => `select public.automation_event_transition('${id(n)}','${op}');`;

test('isolated PostgreSQL automation ledger', async t => {
  const inspect = await run(['inspect',container,'--format','{{.HostConfig.NetworkMode}} {{json .HostConfig.PortBindings}}']);
  assert.equal(inspect.code,0); assert.equal(inspect.out,'none {}');
  await t.test('real non-superuser caller and FORCE RLS / invoker', async () => {
    assert.equal((await sql("select rolsuper,rolbypassrls from pg_roles where rolname=current_user;")).out,'f|t');
    assert.equal((await sql("select relrowsecurity,relforcerowsecurity from pg_class where oid='public.automation_events'::regclass;")).out,'t|t');
    assert.equal((await sql("select prosecdef,proconfig from pg_proc where oid='public.automation_event_transition(text,text)'::regprocedure;")).out,'f|{"search_path=\\"\\""}');
  });
  await t.test('12 concurrent inserts and repeated registrations leave one row', async () => {
    const results=await Promise.all(Array.from({length:12},()=>sql(call(1,'register'))));
    assert.ok(results.every(r=>r.out==='received'));
    assert.equal((await sql(`select count(*) from public.automation_events where event_id='${id(1)}';`)).out,'1');
  });
  await t.test('concurrent completions and terminal timestamp preserved', async () => {
    await Promise.all(Array.from({length:12},()=>sql(call(1,'complete'))));
    const before=(await sql(`select completed_at from public.automation_events where event_id='${id(1)}';`)).out;
    for(const op of ['complete','fail','recover','register']) assert.equal((await sql(call(1,op))).out,'completed');
    assert.equal((await sql(`select completed_at from public.automation_events where event_id='${id(1)}';`)).out,before);
  });
  await t.test('failed event requires explicit recovery', async () => {
    assert.equal((await sql(call(2,'register')+call(2,'fail')+call(2,'complete')+call(2,'recover')+call(2,'complete'))).out,
      'received\nfailed\nfailed\nreceived\ncompleted');
  });
  await t.test('concurrent fail/complete yields one coherent state', async () => {
    await sql(call(3,'register'));
    await Promise.all([sql(call(3,'fail')),sql(call(3,'complete'))]);
    const state=(await sql(`select status from public.automation_events where event_id='${id(3)}';`)).out;
    assert.ok(['failed','completed'].includes(state));
    assert.equal((await sql(call(3,'complete'))).out,state);
  });
  await t.test('rollback removes insertion and rolls back completion', async () => {
    await sql('begin;'+call(4,'register')+'rollback;');
    assert.equal((await sql(`select count(*) from public.automation_events where event_id='${id(4)}';`)).out,'0');
    await sql(call(4,'register'));
    await sql('begin;'+call(4,'complete')+'rollback;');
    assert.equal((await sql(call(4,'register'))).out,'received');
  });
  await t.test('invalid ID/operation, missing event and inconsistent row fail', async () => {
    for(const query of [call(999,'complete'),call(1,'other'),"select public.automation_event_transition(null,'register');",
      `update public.automation_events set status='completed',completed_at=null where event_id='${id(4)}';`]) {
      await sql(query,'service_role',false);
    }
  });
  await t.test('anon and authenticated have neither table nor RPC access', async () => {
    for(const role of ['anon','authenticated']) {
      assert.equal((await sql('select rolsuper,rolbypassrls from pg_roles where rolname=current_user;',role)).out,'f|f');
      for(const query of ['select * from public.automation_events;',call(1,'register'),`insert into public.automation_events(event_id) values('${id(8)}');`]) {
        assert.match((await sql(query,role,false)).err,/permission denied/);
      }
    }
    assert.match((await sql('delete from public.automation_events;','service_role',false)).err,/permission denied/);
  });
  await t.test('RLS blocks non-bypass caller even with table and RPC grants', async () => {
    await sql('grant select,insert,update on public.automation_events to rls_probe; grant execute on function public.automation_event_transition(text,text) to rls_probe;','postgres');
    assert.equal((await sql('select count(*) from public.automation_events;','rls_probe')).out,'0');
    assert.match((await sql(call(8,'register'),'rls_probe',false)).err,/row-level security/);
    await sql('revoke all on public.automation_events from rls_probe; revoke all on function public.automation_event_transition(text,text) from rls_probe;','postgres');
  });
  await t.test('lock is held until rollback and waiter then inserts', async () => {
    const held=sql('begin;'+call(9,'register')+'select pg_sleep(2); rollback;');
    let found=false;
    for(let i=0;i<20;i++) {
      if((await sql("select count(*) from pg_stat_activity where usename='service_role' and wait_event='PgSleep';",'postgres')).out==='1'){found=true;break;}
    }
    assert.ok(found,'lock holder must reach sleep before waiter');
    const waiter=sql(call(9,'register'));
    await held; assert.equal((await waiter).out,'received');
    assert.equal((await sql(`select count(*) from public.automation_events where event_id='${id(9)}';`)).out,'1');
  });
  await t.test('terminated backend rolls back and releases locks', async () => {
    const pending=sql(`set application_name='autodiag_synthetic_disconnect'; begin;${call(10,'register')}select pg_sleep(4);`,'service_role',false);
    let killed=false;
    for(let i=0;i<20;i++) {
      const r=await sql("select pg_terminate_backend(pid) from pg_stat_activity where application_name='autodiag_synthetic_disconnect' and wait_event='PgSleep';",'postgres');
      if(r.out==='t'){killed=true;break;}
    }
    assert.ok(killed); await pending;
    assert.equal((await sql(`select count(*) from public.automation_events where event_id='${id(10)}';`)).out,'0');
    assert.equal((await sql(call(10,'register'))).out,'received');
  });
});
