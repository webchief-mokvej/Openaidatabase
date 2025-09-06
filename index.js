// index.js
import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';
import pg from 'pg';

dotenv.config();
const { Pool } = pg;

const PORT = process.env.PORT || 5050;
const DATABASE_URL = process.env.DATABASE_URL;
const PGSSL = process.env.PGSSL || 'require';       // 'require' or 'verify_full'
const PGSSL_CA = process.env.PGSSL_CA || '';        // PEM text
const PGSSL_CA_B64 = process.env.PGSSL_CA_B64 || '';// optional base64 PEM

if (!DATABASE_URL) {
  console.error('[config] DATABASE_URL is required');
  process.exit(1);
}

let ssl;
if (PGSSL === 'require') {
  // TLS on; don't verify CA (typical for DO managed PG)
  ssl = { rejectUnauthorized: false };
} else if (PGSSL === 'verify_full') {
  const caPem = PGSSL_CA || (PGSSL_CA_B64 ? Buffer.from(PGSSL_CA_B64, 'base64').toString('utf8') : '');
  if (!caPem) {
    console.error('[config] PGSSL=verify_full but no PGSSL_CA/PGSSL_CA_B64 provided');
    process.exit(1);
  }
  ssl = { ca: caPem };
} else {
  ssl = false; // will fail on DO ("no encryption") but left here intentionally
}

console.log('[db] init', { mode: PGSSL, hasPem: !!PGSSL_CA, hasB64: !!PGSSL_CA_B64 });

const pool = new Pool({ connectionString: DATABASE_URL, ssl });

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ===== Utils =====
const nowIso = () => new Date().toISOString();
function xmlEscape(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}
function isMostlySilenceULaw(b64, ratio = 0.92) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return true;
  let near = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0xFF || b === 0x7F || b >= 0xFD) near++; // ulaw silence-ish
  }
  return (near / buf.length) >= ratio;
}

// ===== DB helpers =====
async function loadAgent(agentId) {
  const { rows } = await pool.query(
    `SELECT
       id,
       display_name,
       system_message,
       openai_api_key,
       eleven_api_key,
       eleven_voice_id,
       eleven_model_id,
       pipedream_url,
       pipedream_auth,
       twilio_account_sid,
       twilio_auth_token,
       agent_number,
       vad_threshold,
       vad_prefix_padding_ms,
       vad_silence_duration_ms,
       tts_speed,
       tts_stability,
       tts_similarity_boost
     FROM agents
     WHERE id = $1
     LIMIT 1`,
    [agentId]
  );
  return rows[0] || null;
}
function missingFields(agent) {
  const need = [
    'system_message',
    'openai_api_key',
    'eleven_api_key',
    'eleven_voice_id',
    'twilio_account_sid',
    'twilio_auth_token'
  ];
  return need.filter(k => !agent?.[k]);
}

// ===== In-memory call context =====
const callCtx = new Map(); // callSid -> { agentId, agentRow, callerFrom }

// ===== Twilio REST helpers =====
async function hangupCall(callSid, twilioSid, twilioToken) {
  if (!twilioSid || !twilioToken || !callSid) return;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls/${callSid}.json`;
  const body = new URLSearchParams({ Status: 'completed' });
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) console.error('[twilio] hangup failed', callSid, res.status, await res.text());
    else console.log('[twilio] hangup requested', callSid);
  } catch (e) { console.error('[twilio] hangup error', e); }
}
async function transferCall(callSid, baseUrl, twilioSid, twilioToken) {
  if (!twilioSid || !twilioToken || !callSid) return;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls/${callSid}.json`;
  const twimlUrl = `https://${baseUrl}/transfer`;
  const body = new URLSearchParams({ Url: twimlUrl });
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) console.error('[twilio] transfer failed', res.status, await res.text());
    else console.log('[twilio] transfer requested', callSid, '→ /transfer');
  } catch (e) { console.error('[twilio] transfer error', e); }
}
async function startCallRecording(callSid, recCbUrl, twilioSid, twilioToken) {
  if (!twilioSid || !twilioToken || !callSid) return null;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls/${callSid}/Recordings.json`;
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
  const body = new URLSearchParams({
    RecordingChannels: 'dual',
    RecordingTrack: 'both',
    Trim: 'trim-silence',
    ...(recCbUrl ? { RecordingStatusCallback: recCbUrl, RecordingStatusCallbackMethod: 'POST' } : {})
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) {
      console.error('[twilio] start recording failed', res.status, await res.text());
      return null;
    }
    console.log('[twilio] recording started for', callSid);
    return await res.json().catch(() => null);
  } catch (e) { console.error('[twilio] start recording error', e); return null; }
}
async function postCaptureToPipedream(payload, captureUrl, captureAuth) {
  if (!captureUrl) { console.error('[capture] pipedream_url missing'); return; }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (captureAuth) headers['Authorization'] = `Bearer ${captureAuth}`;
    const res = await fetch(captureUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
    console.log('[capture] posted', res.status);
  } catch (e) { console.error('[capture] error', e); }
}

// ===== Health =====
fastify.get('/healthz', async (_req, reply) => reply.send({ ok: true, t: nowIso() }));
fastify.get('/db-ping', async (_req, reply) => {
  await pool.query('select 1');
  reply.send({ ok: 1, mode: PGSSL, hasPem: !!PGSSL_CA, hasB64: !!PGSSL_CA_B64, t: nowIso() });
});
fastify.get('/', async (_req, reply) => reply.send({ message: 'Twilio Media Stream Server is running!' }));

// ===== TwiML: transfer =====
fastify.all('/transfer', async (req, reply) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || '';
  const ctx = callCtx.get(callSid);
  const agent = ctx?.agentRow;

  if (!agent) {
    console.error('[transfer] no agent for CallSid', callSid);
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Transfer unavailable.</Say></Response>`);
    return;
  }
  if (!agent.agent_number) {
    console.error('[transfer] agent_number missing for agent', agent.id);
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Transfer number not configured.</Say></Response>`);
    return;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>${xmlEscape(agent.agent_number)}</Dial>
</Response>`;
  console.log('[transfer] dialing', agent.agent_number, 'for', callSid);
  reply.type('text/xml').send(twiml);
});

// ===== TwiML: incoming-call (agentId in path) =====
fastify.all('/incoming-call/:agentId', async (request, reply) => {
  const { agentId } = request.params;
  const from    = request.body?.From    || request.query?.From    || '';
  const callSid = request.body?.CallSid || request.query?.CallSid || '';
  const host    = request.headers['x-forwarded-host'] || request.headers.host;

  console.log('[twiml] /incoming-call', { agentId, from, callSid, host });

  // Just build TwiML; agent is loaded in WS (so we can surface close reason if misconfigured)
  const streamUrl =
    `wss://${host}/media-stream` +
    `?agentId=${encodeURIComponent(agentId)}` +
    `&callSid=${encodeURIComponent(callSid)}` +
    `&host=${encodeURIComponent(host)}`;

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${streamUrl}">
      <Parameter name="agentId" value="${xmlEscape(agentId)}"/>
      <Parameter name="from" value="${xmlEscape(from)}"/>
      <Parameter name="callSid" value="${xmlEscape(callSid)}"/>
      <Parameter name="host" value="${xmlEscape(host)}"/>
    </Stream>
  </Connect>
</Response>`;
  reply.type('text/xml').send(twimlResponse);
});

// Recording status
fastify.post('/recording-status/:agentId', async (req, reply) => {
  const { agentId } = req.params || {};
  const { CallSid, RecordingSid, RecordingStatus, RecordingUrl } = req.body || {};
  if (RecordingStatus === 'completed' && RecordingSid && RecordingUrl) {
    const url = `${RecordingUrl}.mp3?RequestedChannels=2`;
    console.log('[recording] completed', { agentId, callSid: CallSid, recordingSid: RecordingSid, url });
  } else {
    console.log('[recording-status]', { agentId, CallSid, RecordingSid, RecordingStatus });
  }
  reply.send('ok');
});

// ===== Media Stream (WebSocket) =====
fastify.register(async (app) => {
  app.get('/media-stream', { websocket: true }, (connection, req) => {
    // Handshake diagnostics
    const forwardedHost = req.headers['x-forwarded-host'] || req.headers.host || 'unknown-host';
    console.log('[ws] handshake', {
      path: req.url,
      hostHeader: req.headers.host,
      xfHost: req.headers['x-forwarded-host'],
      origin: req.headers.origin,
      ua: req.headers['user-agent'] || ''
    });

    // Parse query
    let q;
    try { q = new URL(req.url, `https://${forwardedHost}`).searchParams; } catch {}
    let streamSid = null;
    let callSid   = q?.get('callSid') || null;
    let agentId   = q?.get('agentId') || null;
    let baseHost  = q?.get('host')    || (req.headers['x-forwarded-host'] || req.headers.host);
    let callerFrom = null;

    let latestMediaTimestamp = 0;
    let lastUserAudioAt = Date.now();

    // Resolved agent config
    let agent = null;

    // AI/TTS state
    let openAiWs = null;
    let activeResponseId = null;
    let isResponseInProgress = false;
    let isTtsSpeaking = false;
    let sawTextDelta = false;

    // Tokens / capture
    const END_TOKEN = '<END_CALL>';
    const CAPTURE_TOKEN = '<CAPTURE_JOB>';
    const CAPTURE_JSON_START = '[[CAPTURE_JSON]]';
    const CAPTURE_JSON_END   = '[[/CAPTURE_JSON]]';
    const TRANSFER_TOKEN = '<TRANSFER_AGENT>';
    let endTokenSeen = false;
    let captureTokenSeen = false;
    let capturePosted = false;
    let transferTokenSeen = false;

    let textTail = '';
    let scanBuf = '';
    let captureJson = null;
    let captureJsonReady = false;

    // TTS (Eleven)
    let elevenWs = null;
    let elevenOpen = false;
    const elevenQueue = [];
    let elevenPing = null;
    let suppressTts = false;

    const maxTokenLen = Math.max(
      END_TOKEN.length, CAPTURE_TOKEN.length, CAPTURE_JSON_START.length, CAPTURE_JSON_END.length, TRANSFER_TOKEN.length
    );
    const escapeForRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const sendMark = () => { if (streamSid) connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } })); };

    function checkAndHandleTokens(combined) {
      if (!captureTokenSeen && combined.includes(CAPTURE_TOKEN)) { captureTokenSeen = true; console.log('[token]', agentId, callSid, 'CAPTURE'); }
      if (!endTokenSeen && combined.includes(END_TOKEN))         { endTokenSeen = true;     console.log('[token]', agentId, callSid, 'END'); }
      if (!transferTokenSeen && combined.includes(TRANSFER_TOKEN)) { transferTokenSeen = true; console.log('[token]', agentId, callSid, 'TRANSFER'); }
    }
    function stripNonSpoken(text) {
      let out = text.replaceAll(CAPTURE_TOKEN,'').replaceAll(END_TOKEN,'').replaceAll(TRANSFER_TOKEN,'');
      const reBlock = new RegExp(escapeForRegex(CAPTURE_JSON_START)+'[\\s\\S]*?'+escapeForRegex(CAPTURE_JSON_END),'g');
      out = out.replace(reBlock,'').replaceAll(CAPTURE_JSON_START,'').replaceAll(CAPTURE_JSON_END,'');
      return out;
    }
    function tryParseCaptureJsonBlocks() {
      if (captureJson || capturePosted) return;
      let startIdx = scanBuf.indexOf(CAPTURE_JSON_START);
      let endIdx = scanBuf.indexOf(CAPTURE_JSON_END, startIdx + CAPTURE_JSON_START.length);
      if (startIdx !== -1 && endIdx !== -1) {
        const raw = scanBuf.substring(startIdx + CAPTURE_JSON_START.length, endIdx).trim();
        scanBuf = scanBuf.slice(0, startIdx) + scanBuf.slice(endIdx + CAPTURE_JSON_END.length);
        try { captureJson = JSON.parse(raw); captureJsonReady = true; console.log('[capture] JSON parsed'); }
        catch (e) { console.warn('[capture] JSON parse failed', e); }
      }
      if (scanBuf.length > 8000) scanBuf = scanBuf.slice(-4000);
    }
    function extractFinalTextFromResponseDone(resp) {
      try {
        const out = resp?.output; if (!Array.isArray(out)) return '';
        let text = '';
        for (const item of out) {
          if (item?.type === 'message' && Array.isArray(item.content)) {
            for (const c of item.content) {
              if ((c?.type === 'output_text' || c?.type === 'text') && typeof c?.text === 'string') {
                text += (text ? ' ' : '') + c.text;
              }
            }
          }
          if (!text && typeof item?.text === 'string') text = item.text;
        }
        return (text || '').trim();
      } catch { return ''; }
    }

    // Require agentId in query (so we can close with reason if bad)
    if (!agentId) {
      console.error('[ws] missing agentId in query; closing');
      try { connection.close(1011, 'missing agentId'); } catch {}
      return;
    }

    // ===== Eleven helpers =====
    function createElevenSocket(xiKey, voiceId, modelId) {
      const url =
        `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
        `?model_id=${encodeURIComponent(modelId || 'eleven_turbo_v2_5')}` +
        `&output_format=ulaw_8000&auto_mode=true`;
      const ws = new WebSocket(url, { headers: { 'xi-api-key': xiKey } });
      ws.binaryType = 'nodebuffer';
      return ws;
    }
    function flushElevenQueue() {
      if (!elevenOpen || !elevenWs) return;
      while (elevenQueue.length) {
        const frame = elevenQueue.shift();
        try { elevenWs.send(JSON.stringify(frame)); } catch (e) { console.error('[eleven] flush send error', e); break; }
      }
    }
    function sendToEleven(frame) { elevenQueue.push(frame); if (elevenOpen) flushElevenQueue(); }
    function ensureEleven() {
      if (elevenWs && elevenOpen) return;
      if (elevenWs && !elevenOpen) return;
      if (!agent?.eleven_api_key || !agent?.eleven_voice_id) { console.error('[eleven] missing creds/voice'); return; }
      elevenWs = createElevenSocket(agent.eleven_api_key, agent.eleven_voice_id, agent.eleven_model_id);
      elevenOpen = false;

      elevenWs.on('open', () => {
        elevenOpen = true;
        sendToEleven({ text: ' ', voice_settings: {
          speed: Number(agent.tts_speed ?? 1.05),
          stability: Number(agent.tts_stability ?? 0.45),
          similarity_boost: Number(agent.tts_similarity_boost ?? 0.85)
        }});
        flushElevenQueue();
        if (!elevenPing) elevenPing = setInterval(() => { try { elevenWs.ping(); } catch {} }, 20000);
        console.log('[eleven] WS open', agentId, callSid);
      });
      elevenWs.on('message', (data, isBinary) => {
        try {
          if (isBinary) {
            if (suppressTts) return;
            const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
            if (streamSid) connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
            return;
          }
          const msg = JSON.parse(data.toString());
          if (msg.audio && streamSid && !suppressTts) {
            connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.audio } }));
          }
        } catch (e) { console.error('[eleven] message error', e); }
      });
      elevenWs.on('close', (code, r) => { console.log('[eleven] WS close', code, r?.toString?.()); elevenOpen = false; });
      elevenWs.on('error', (e) => { console.error('[eleven] WS error', e); });
    }

    // ===== OpenAI Realtime =====
    function createAndWireOpenAi() {
      if (!agent?.openai_api_key) { console.error('[ai] missing openai_api_key'); return; }
      const openAi = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
        { headers: { Authorization: `Bearer ${agent.openai_api_key}`, 'OpenAI-Beta': 'realtime=v1' } }
      );
      openAiWs = openAi;

      openAi.on('open', () => {
        const sessionUpdate = {
          type: 'session.update',
          session: {
            turn_detection: {
              type: 'server_vad',
              threshold: Number(agent.vad_threshold ?? 0.70),
              prefix_padding_ms: Number(agent.vad_prefix_padding_ms ?? 300),
              silence_duration_ms: Number(agent.vad_silence_duration_ms ?? 320),
              create_response: true,
              interrupt_response: true
            },
            input_audio_noise_reduction: { type: 'near_field' },
            input_audio_format: 'g711_ulaw',
            modalities: ['text'],
            instructions: agent.system_message,
            temperature: 0.8
          }
        };
        console.log('[ai] session.update', agentId, sessionUpdate.session.turn_detection);
        openAi.send(JSON.stringify(sessionUpdate));

        // Initial greeting (exact)
        openAi.send(JSON.stringify({
          type: 'response.create',
          response: {
            modalities: ['text'],
            instructions: 'Greet the caller now with exactly: "Hello, thank you for calling Word towing services, how can I help you ?" Then wait for the caller.'
          }
        }));
      });

      openAi.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());

          if (msg.type === 'response.created') {
            activeResponseId = msg.response?.id || null;
            isResponseInProgress = true;
            sawTextDelta = false;
            suppressTts = false;
            return;
          }

          if (msg.type === 'response.output_text.delta' && typeof msg.delta === 'string') {
            const deltaRaw = msg.delta;
            scanBuf += deltaRaw; tryParseCaptureJsonBlocks();
            const combined = (textTail + deltaRaw);
            checkAndHandleTokens(combined);
            const deltaSpeak = stripNonSpoken(deltaRaw);
            textTail = combined.slice(-Math.max(1, maxTokenLen - 1));
            sawTextDelta = true;

            if (deltaSpeak) { ensureEleven(); sendToEleven({ text: deltaSpeak, try_trigger_generation: true }); isTtsSpeaking = true; sendMark(); }
            return;
          }

          if (msg.type === 'response.output_text.done' && typeof msg.text === 'string' && msg.text.length && !sawTextDelta) {
            const textRaw = msg.text;
            scanBuf += textRaw; tryParseCaptureJsonBlocks();
            const text = stripNonSpoken(textRaw);
            if (text) { ensureEleven(); sendToEleven({ text, try_trigger_generation: true }); isTtsSpeaking = true; }
            return;
          }

          if (msg.type === 'response.done') {
            if (!sawTextDelta) {
              const finalTextRaw = extractFinalTextFromResponseDone(msg.response);
              if (finalTextRaw) {
                scanBuf += finalTextRaw; tryParseCaptureJsonBlocks();
                const cleaned = stripNonSpoken(finalTextRaw);
                if (cleaned) { ensureEleven(); sendToEleven({ text: cleaned, try_trigger_generation: true }); isTtsSpeaking = true; }
              }
            }
            if (isTtsSpeaking) sendToEleven({ flush: true });
            isTtsSpeaking = false;

            if ((captureTokenSeen || captureJsonReady) && !capturePosted) {
              capturePosted = true;
              postCaptureToPipedream(
                { type: 'tow_capture', at: nowIso(), callSid, from: callerFrom, job: captureJson || null },
                agent.pipedream_url,
                agent.pipedream_auth
              );
              captureTokenSeen = false; captureJsonReady = false; captureJson = null; scanBuf = '';
            }

            if (transferTokenSeen) {
              transferTokenSeen = false;
              setTimeout(() => { transferCall(callSid, baseHost, agent.twilio_account_sid, agent.twilio_auth_token); }, 1500);
            }

            if (endTokenSeen) {
              setTimeout(() => {
                hangupCall(callSid, agent.twilio_account_sid, agent.twilio_auth_token);
                try { connection.close(); } catch {}
              }, 1500);
            }

            isResponseInProgress = false;
            activeResponseId = null;
            sawTextDelta = false;
            textTail = '';
            try { openAi.send(JSON.stringify({ type: 'input_audio_buffer.clear' })); } catch {}
            return;
          }

          if (msg.type === 'input_audio_buffer.speech_started') {
            suppressTts = true;
            if (isResponseInProgress) {
              try { openAi.send(JSON.stringify({ type: 'response.cancel' })); } catch {}
            }
            connection.send(JSON.stringify({ event: 'clear', streamSid }));
            return;
          }

          if (msg.type === 'input_audio_buffer.speech_stopped') {
            suppressTts = false;
            return;
          }

          if (msg.type === 'error') { console.error('[ai] error', msg.error); }
        } catch (e) {
          console.error('[ai] message parse error', e, 'Raw:', data?.toString?.());
        }
      });

      openAi.on('close', (code, r) => { console.log('[ai] ws close', code, r?.toString?.(), agentId, callSid); });
      openAi.on('error', (e) => { console.error('[ai] ws error', e); });
    }

    // ---- Twilio → OpenAI (caller audio) ----
    connection.on('message', async (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'connected':
            console.log('[twilio] event connected');
            break;

          case 'start': {
            streamSid = data.start.streamSid;
            callSid   = data.start.callSid || callSid;

            // Parse <Parameter/> values too
            const params = {};
            const raw = data.start?.customParameters ?? data.start?.custom_parameters;
            if (Array.isArray(raw)) for (const p of raw) if (p && typeof p === 'object' && 'name' in p) params[p.name] = p.value ?? '';
            else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) params[k] = v ?? '';

            agentId    = agentId || params.agentId || null;
            callerFrom = params.from || callerFrom || '';
            baseHost   = baseHost || params.host || req.headers['x-forwarded-host'] || req.headers.host;

            // Load agent NOW so if it's missing we close with a reason Twilio will echo
            try {
              agent = await loadAgent(agentId);
            } catch (e) {
              console.error('[start] DB error while loading agent', agentId, e);
              try { connection.close(1011, 'db error'); } catch {}
              return;
            }
            if (!agent) {
              console.error('[start] agent not found', { agentId, callSid });
              try { connection.close(1008, 'agent not found'); } catch {}
              return;
            }
            const miss = missingFields(agent);
            if (miss.length) {
              console.error('[start] agent misconfigured', agentId, 'missing:', miss);
              try { connection.close(1008, 'agent misconfigured'); } catch {}
              return;
            }

            console.log('[twilio] stream start', { agentId, streamSid, callSid, from: callerFrom || '(empty)', host: baseHost || '(empty)' });

            // Start recording (best-effort)
            const recCb = baseHost ? `https://${baseHost}/recording-status/${encodeURIComponent(agent.id)}` : '';
            startCallRecording(callSid, recCb, agent.twilio_account_sid, agent.twilio_auth_token);

            // Create OpenAI session (also triggers greeting)
            createAndWireOpenAi();

            latestMediaTimestamp = 0;
            lastUserAudioAt = Date.now();

            // Best-effort store
            callCtx.set(callSid, { agentId: agent.id, agentRow: agent, callerFrom });
            break;
          }

          case 'media': {
            latestMediaTimestamp = data.media.timestamp;
            lastUserAudioAt = Date.now();
            const payload = data.media.payload;
            if (isMostlySilenceULaw(payload)) break;
            if (openAiWs && openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
            }
            break;
          }

          case 'stop':
            console.log('[twilio] event stop');
            break;

          default:
            console.log('[twilio] event', data.event);
            break;
        }
      } catch (e) {
        console.error('Error parsing Twilio message:', e, 'Message:', message);
      }
    });

    // Log close code & reason (helps diagnose “application error”)
    connection.on('close', (code, reasonBuf) => {
      const reason = reasonBuf ? reasonBuf.toString() : '';
      console.log('[ws] close', { code, reason, agentId, callSid });
      try { if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
      try { if (elevenWs && elevenWs.readyState === WebSocket.OPEN) elevenWs.close(); } catch {}
      if (elevenPing) { clearInterval(elevenPing); elevenPing = null; }
      if (callSid) callCtx.delete(callSid);
    });

    connection.on('error', (err) => {
      console.error('[ws] socket error', err);
    });
  });
});

// Start server
const host = '0.0.0.0';
fastify.listen({ port: PORT, host }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`[${nowIso()}] Server is listening on ${address}`);
});
