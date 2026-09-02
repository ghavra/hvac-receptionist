import { WebSocket as ws } from 'ws';
globalThis.WebSocket = globalThis.WebSocket || ws;

import express from 'express';
import { createClient } from '@supabase/supabase-js';
import twilio from 'twilio';
import { Resend } from 'resend';

// Lazy clients: server boots even if a variable is missing (easier debugging)
let _sb, _tw, _re;
const sb = () => (_sb ??= createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY));
const tw = () => (_tw ??= twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH_TOKEN));
const re = () => (_re ??= new Resend(process.env.RESEND_API_KEY));

const REQUIRED = ['name', 'phone', 'address', 'city', 'issue', 'urgency', 'availability'];

const app = express();
app.use(express.json());

// ---- Browser check routes ----
app.get('/', (req, res) => res.send('Server is live'));

// Visit /seed?key=YOUR_VAPI_SECRET once after deploying (fills the schedule)
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

// Visit /test-save?key=YOUR_VAPI_SECRET to verify the database connection
app.get('/test-save', async (req, res) => {
  if (req.query.key !== process.env.VAPI_SECRET) return res.sendStatus(401);
  try { res.json(await saveProfile('browser-test', { name: 'John' }, '+15550000000')); }
  catch (e) { res.status(500).send('Test failed: ' + e.message); }
});

// ---- The Vapi webhook (this is what Vapi talks to) ----
app.post('/webhook/vapi', async (req, res) => {
  if (req.headers['x-vapi-secret'] !== process.env.VAPI_SECRET) return res.sendStatus(401);
  const msg = req.body.message;
  if (!msg) return res.sendStatus(200);
  try {
    if (msg.type === 'tool-calls' || msg.type === 'tool-call') {
      const calls = msg.toolCalls ?? (msg.toolCall ? [msg.toolCall] : []);
      const results = [];
      for (const tc of calls) results.push({ result: await runTool(tc, msg) });
      return res.json(results);
    }
    if (msg.type === 'end-of-call-report') {
      res.sendStatus(200);
      finalizeLead(msg).catch(console.error);
      return;
    }
  } catch (e) {
    console.error('webhook error', e);
    return res.json([{ result: JSON.stringify({ error: 'temporary system issue' }) }]);
  }
  res.sendStatus(200);
});

// ---- TOOLS ----
async function runTool(tc, msg) {
  const name = tc.function?.name;
  let args = {};
  try { args = JSON.parse(tc.function?.arguments || '{}'); } catch {}

  if (name === 'saveCustomerInfo') {
    const p = await saveProfile(msg.call.id, args, msg.call?.customer?.number);
    return JSON.stringify({ received: p.received, stillNeeded: p.stillNeeded });
  }
  if (name === 'checkAvailability') return JSON.stringify({ slots: await findSlots(args.preference) });
  if (name === 'bookAppointment') return JSON.stringify(await book(msg.call.id, args.slotId));
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
  if (!merged.phone && callerPhone) merged.phone = callerPhone; // caller-ID prefill

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

  const chosen = (filtered.length ? filtered : open ?? []).slice(0, 3);
  
  if (chosen.length === 0) {
    return { error: "No slots available in the database. Tell the user a manager will call them to schedule manually." };
  }

  return chosen.map(s => ({
    id: s.id,
    when: new Date(s.starts_at).toLocaleString('en-US',
      { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  }));
}

async function book(callId, slotId) {
  if (!slotId) return { status: 'error', message: 'missing slotId' };

  const { data: slot, error } = await sb().from('slots')
    .update({ booked: true }).eq('id', slotId).eq('booked', false)
    .select().maybeSingle();
  if (error) console.error('book claim error:', error.message);
  if (!slot) return { status: 'no_longer_available', alternatives: await findSlots('') };

  const code = 'HV-' + Math.floor(1000 + Math.random() * 9000);
  const when = new Date(slot.starts_at).toLocaleString('en-US',
    { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const { error: insErr } = await sb().from('appointments').insert({ call_id: callId, slot_id: slotId, confirmation_code: code });
  if (insErr) console.error('appointment insert error:', insErr.message);

  notifyOwnerInstant(callId, code, when).catch(console.error);
  return { status: 'confirmed', confirmationCode: code, when };
}

// ---- END OF CALL + NOTIFICATIONS ----
async function finalizeLead(msg) {
  const extracted = msg.analysis?.structuredData ?? {};
  const { data: profile } = await sb().from('call_profiles').select().eq('call_id', msg.call.id).maybeSingle();
  const { data: appt } = await sb().from('appointments')
    .select('confirmation_code, slots(starts_at)').eq('call_id', msg.call.id).maybeSingle();

  const EXT = { name: 'customerName', phone: 'phone', address: 'address', city: 'city',
                issue: 'issue', system_type: 'systemType', urgency: 'urgency', availability: 'availability' };
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

// ---- DEBUG ROUTE ----
app.get('/debug', async (req, res) => {
  if (req.query.key !== process.env.VAPI_SECRET) return res.sendStatus(401);
  try {
    const { data: all, error: err1 } = await sb().from('slots').select('*').limit(5);
    const { data: open, error: err2 } = await sb().from('slots')
      .select('id, starts_at, booked')
      .eq('booked', false)
      .gte('starts_at', new Date().toISOString())
      .limit(5);
    const { count } = await sb().from('slots').select('*', { count: 'exact', head: true });
    
    res.json({
      totalSlotsInDB: count,
      firstFiveSlots: all,
      firstFiveOpenSlots: open,
      errors: { all: err1?.message, open: err2?.message },
      serverTime: new Date().toISOString()
    });
  } catch (e) { res.status(500).send('Debug failed: ' + e.message); }
});

app.listen(process.env.PORT || 3000);
