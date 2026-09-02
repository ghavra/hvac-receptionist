import { WebSocket as ws } from 'ws';
globalThis.WebSocket = globalThis.WebSocket || ws;

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { Resend } from 'resend';

let _sb, _tw, _re;
const sb = () => (_sb ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));
const tw = () => (_tw ??= twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN));
const re = () => (_re ??= new Resend(process.env.RESEND_API_KEY));

const REQUIRED = ['name', 'phone', 'address', 'city', 'issue', 'urgency', 'availability'];

const app = express();
// CHANGE 1: bigger body limit so large Vapi payloads can't be silently rejected
app.use(express.json({ limit: '2mb' }));

// CHANGE 2: log every request so you can watch Vapi's calls live in Railway logs
app.use((req, res, next) => {
  console.log('>> ' + req.method + ' ' + req.originalUrl + ' | x-vapi-secret: ' +
    (req.headers['x-vapi-secret'] === undefined ? 'MISSING' : 'present'));
  next();
});

app.get('/', (req, res) => res.send('Server is live'));

app.get('/seed', async (req, res) => {
  if (req.query.key !== process.env.VAPI_SECRET) return res.sendStatus(401);
  try {
    let n = 0;
    for (let d = 1; d <= 7; d++) {
      const day = new Date(); day.setDate(day.getDate() + d);
      for (let h = 8; h < 17; h++) {
        const s = new Date(day); s.setHours(h, 0, 0, 0);
        const { error } = await sb().from('slots').upsert({ id: 's' + Math.floor(s.getTime() / 1000), starts_at: s.toISOString(), booked: false });
        if (error) throw error;
        n++;
      }
    }
    res.send('Seeded ' + n + ' slots (next 7 days, 8am-4pm). Safe to re-run anytime.');
  } catch (e) { res.status(500).send('Seed failed: ' + e.message); }
});

app.get('/test-save', async (req, res) => {
  if (req.query.key !== process.env.VAPI_SECRET) return res.sendStatus(401);
  try { res.json(await saveProfile('browser-test', { name: 'John' }, '+15550000000')); }
  catch (e) { res.status(500).send('Test failed: ' + e.message); }
});

// NEW: browser-based end-to-end test — no phone call needed
// Open: https://YOUR-APP.up.railway.app/selftest?key=YOUR_VAPI_SECRET
app.get('/selftest', async (req, res) => {
  if (req.query.key !== process.env.VAPI_SECRET) return res.sendStatus(401);
  const payload = {
    message: {
      type: 'tool-calls',
      toolCalls: [{
        id: 'selftest-1', type: 'function',
        function: { name: 'checkAvailability', arguments: JSON.stringify({ preference: 'tomorrow morning' }) }
      }],
      call: { id: 'selftest-' + Date.now(), customer: { number: '+15550000000' } }
    }
  };
  const post = async (withSecret) => {
    const headers = { 'Content-Type': 'application/json' };
    if (withSecret) headers['x-vapi-secret'] = process.env.VAPI_SECRET;
    const r = await fetch('http://localhost:' + (process.env.PORT || 3000) + '/webhook/vapi', {
      method: 'POST', headers, body: JSON.stringify(payload)
    });
    return { httpStatus: r.status, responseBody: (await r.text()).slice(0, 500) };
  };
  const out = {};
  try { out.withSecretHeader = await post(true); } catch (e) { out.withSecretHeader = { error: e.message }; }
  try { out.withoutSecretHeader = await post(false); } catch (e) { out.withoutSecretHeader = { error: e.message }; }
  const ok = out.withSecretHeader.httpStatus === 200 && (out.withSecretHeader.responseBody || '').includes('"result"');
  out.verdict = ok
    ? 'PASS: server returns 200 + [{ "result": "..." }], exactly what Vapi expects. If Vapi still says "No result returned", the problem is in the Vapi tool settings (per-tool Server URL without secret, async enabled, or wrong URL) — not this server.'
    : 'FAIL: this server is NOT returning a valid tool result. Check withSecretHeader above and the Railway logs.';
  res.json(out);
});

app.post('/webhook/vapi', async (req, res) => {
  // CHANGE 3: make auth failures LOUD instead of silent
  if (req.headers['x-vapi-secret'] !== process.env.VAPI_SECRET) {
    console.log('!! AUTH FAILED -> 401. header received: ' + JSON.stringify(req.headers['x-vapi-secret']) +
      ' | VAPI_SECRET on server: ' + JSON.stringify(process.env.VAPI_SECRET));
    return res.sendStatus(401);
  }

  const msg = req.body?.message;
  if (!msg) { console.log('!! request had no "message" object'); return res.sendStatus(200); }

  try {
    if (msg.type === 'tool-calls' || msg.type === 'tool-call') {
      const calls = msg.toolCalls ?? (msg.toolCall ? [msg.toolCall] : []);
      console.log('>> tool message "' + msg.type + '": ' + (calls.map(c => c.function?.name).join(', ') || 'NO CALLS FOUND'));
      if (!calls.length) console.log('!! no tool calls in payload. message keys: ' + Object.keys(msg).join(', '));

      const results = [];
      for (const tc of calls) {
        const result = await runTool(tc, msg);
        console.log('>> result sent to Vapi for "' + tc.function?.name + '": ' + String(result).slice(0, 300));
        results.push({ result });
      }
      // CHANGE 4: "tool-calls" (plural) expects an ARRAY of results; "tool-call" (singular) expects ONE object
      return res.json(msg.type === 'tool-call' && results.length === 1 ? results[0] : results);
    }

    if (msg.type === 'end-of-call-report') {
      res.sendStatus(200);
      finalizeLead(msg).catch(console.error);
      return;
    }
  } catch (e) {
    console.error('!! webhook error', e);
    return res.json([{ result: 'Temporary system error, please try again.' }]);
  }
  res.sendStatus(200);
});

async function runTool(tc, msg) {
  const name = tc.function?.name;
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}

  if (name === 'saveCustomerInfo') {
    const p = await saveProfile(msg.call.id, args, msg.call?.customer?.number);
    return JSON.stringify({ received: p.received, stillNeeded: p.stillNeeded });
  }

  if (name === 'checkAvailability') {
    const result = await findSlots(args.preference);
    if (result.error) return JSON.stringify({ error: result.error });
    if (!result.slots || result.slots.length === 0) return JSON.stringify({ error: "No slots available. Tell the user a manager will call them." });
    const slotText = result.slots.map(s => `${s.when} (ID: ${s.id})`).join(', ');
    if (result.fallback) {
      return `I couldn't find any slots matching the exact preference, but here are the closest available times: ${slotText}. Ask the user if any of these work.`;
    }
    return `Available slots: ${slotText}. Ask the user which one they prefer.`;
  }

  if (name === 'bookAppointment') {
    const booking = await book(msg.call.id, args.slotId);
    if (booking.status === 'confirmed') {
      return `Appointment confirmed for ${booking.when}. Confirmation code is ${booking.confirmationCode}. Tell the user their appointment is booked.`;
    }
    return JSON.stringify(booking);
  }

  return JSON.stringify({ error: 'unknown tool ' + name });
}

async function saveProfile(callId, args, callerPhone) {
  const { data: existing, error: selErr } = await sb().from('call_profiles').select().eq('call_id', callId).maybeSingle();
  if (selErr) console.error('saveProfile select error:', selErr.message);
  const merged = { ...(existing ?? {}), call_id: callId, customer_phone: callerPhone ?? existing?.customer_phone };

  for (const k of ['name', 'phone', 'address', 'city', 'issue', 'urgency', 'availability']) {
    if (typeof args[k] === 'string' && args[k].trim()) merged[k] = args[k].trim();
  }
  if (typeof args.systemType === 'string' && args.systemType.trim()) merged.system_type = args.systemType.trim();
  if (!merged.phone && callerPhone) merged.phone = callerPhone;

  if (existing) {
    const { error } = await sb().from('call_profiles').update(merged).eq('call_id', callId);
    if (error) console.error('saveProfile update error:', error.message);
  } else {
    const { error } = await sb().from('call_profiles').insert(merged);
    if (error) console.error('saveProfile insert error:', error.message);
  }

  merged.received = REQUIRED.filter(k => merged[k]);
  merged.stillNeeded = REQUIRED.filter(k => !merged[k]);
  return merged;
}

async function findSlots(preference) {
  const { data: open, error } = await sb().from('slots')
    .select('id, starts_at')
    .eq('booked', false)
    .gte('starts_at', new Date().toISOString())
    .order('starts_at').limit(60);

  if (error) {
    console.error('findSlots error:', error.message);
    return { error: "Database error finding slots." };
  }

  const p = (preference || '').toLowerCase();
  const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  let filtered = open ?? [];
  const day = days.find(d => p.includes(d));
  if (day) filtered = filtered.filter(s => new Date(s.starts_at).getDay() === days.indexOf(day));
  const h = s => new Date(s.starts_at).getHours();
  if (/morning/.test(p)) filtered = filtered.filter(s => h(s) < 12);
  else if (/afternoon/.test(p)) filtered = filtered.filter(s => h(s) >= 12 && h(s) < 17);
  else if (/evening/.test(p)) filtered = filtered.filter(s => h(s) >= 17);

  let isFallback = false;
  let chosen = filtered;
  if (chosen.length === 0) { chosen = open ?? []; isFallback = true; }

  const finalSlots = chosen.slice(0, 3);
  if (finalSlots.length === 0) return { error: "No slots available in the database." };

  const mapped = finalSlots.map(s => ({
    id: s.id,
    when: new Date(s.starts_at).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }));
  return { slots: mapped, fallback: isFallback };
}

async function book(callId, slotId) {
  if (!slotId) return { status: 'error', message: 'missing slotId' };

  const { data: slot, error } = await sb().from('slots')
    .update({ booked: true }).eq('id', slotId).eq('booked', false)
    .select().maybeSingle();
  if (error) console.error('book claim error:', error.message);
  if (!slot) return { status: 'no_longer_available', alternatives: await findSlots('') };

  const code = 'HV-' + Math.floor(1000 + Math.random() * 9000);
  const when = new Date(slot.starts_at).toLocaleString('en-US', { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const { error: insErr } = await sb().from('appointments').insert({ call_id: callId, slot_id: slotId, confirmation_code: code });
  if (insErr) console.error('appointment insert error:', insErr.message);

  notifyOwnerInstant(callId, code, when).catch(console.error);
  return { status: 'confirmed', confirmationCode: code, when };
}

async function finalizeLead(msg) {
  const extracted = msg.analysis?.structuredData ?? {};
  const { data: profile } = await sb().from('call_profiles').select().eq('call_id', msg.call.id).maybeSingle();
  const { data: appt } = await sb().from('appointments')
    .select('confirmation_code, slots(starts_at)').eq('call_id', msg.call.id).maybeSingle();

  const EXT = { name: 'customerName', phone: 'phone', address: 'address', city: 'city', issue: 'issue', system_type: 'systemType', urgency: 'urgency', availability: 'availability' };
  const lead = { call_id: msg.call.id };
  for (const [db, ext] of Object.entries(EXT)) lead[db] = profile?.[db] ?? extracted[ext] ?? null;
  lead.booked = !!appt;
  lead.appointment_time = appt ? appt.slots.starts_at : extracted.appointmentTime ?? null;
  lead.sentiment = extracted.sentiment ?? null;
  lead.ended_reason = msg.endedReason;
  lead.transcript = msg.transcript;

  const { error } = await sb().from('leads').upsert(lead, { onConflict: 'call_id' });
  if (error) console.error('leads upsert error:', error.message);
  await sendOwnerSheet(lead);
}

async function notifyOwnerInstant(callId, code, when) {
  const { data: p } = await sb().from('call_profiles').select('name, issue, customer_phone').eq('call_id', callId).maybeSingle();
  await sms('BOOKED: ' + (p?.name ?? 'New lead') + ' — ' + when + ' (' + code + '). Callback ' + (p?.customer_phone ?? 'unknown') + '. Issue: ' + (p?.issue ?? 'n/a'));
}

async function sendOwnerSheet(lead) {
  await sms('Lead complete: ' + (lead.name ?? 'Unknown') + (lead.booked ? ' — BOOKED' : ' — not booked') + '. ' + (lead.phone ?? 'no phone') + '. Full sheet in email.');
  const rows = Object.entries(lead).filter(([k]) => k !== 'transcript')
    .map(([k, v]) => k + ': ' + (v ?? '—')).join('\n');
  const { error } = await re().emails.send({
    from: process.env.OWNER_EMAIL_FROM, to: process.env.OWNER_EMAIL,
    subject: 'New lead: ' + (lead.name ?? 'Unknown') + (lead.booked ? ' (BOOKED)' : ''),
    text: rows + '\n\n--- TRANSCRIPT ---\n' + (lead.transcript || '(none)')
  });
  if (error) console.error('email error:', error.message);
}

async function sms(body) {
  for (let i = 0; i < 4; i++) {
    try { return await tw().messages.create({ body, from: process.env.TWILIO_FROM, to: process.env.OWNER_PHONE }); }
    catch (e) { console.error('twilio retry ' + i + ':', e.message); await new Promise(r => setTimeout(r, 500 * 2 ** i)); }
  }
  await sb().from('notify_failures').insert({ channel: 'sms', body });
}

app.listen(process.env.PORT || 3000);
