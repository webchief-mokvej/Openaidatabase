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
const PGSSL = process.env.PGSSL || 'require';         // 'require' | 'verify_full'
const PGSSL_CA = process.env.PGSSL_CA || '';          // PEM string
const PGSSL_CA_B64 = process.env.PGSSL_CA_B64 || '';  // optional base64 of PEM

if (!DATABASE_URL) {
  console.error('[config] DATABASE_URL is required');
  process.exit(1);
}

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// ===== DB =====
let ssl;
if (PGSSL === 'require') {
  ssl = { rejectUnauthorized: false }; // TLS on, no CA verify (works on DO)
} else if (PGSSL === 'verify_full') {
  const caPem = PGSSL_CA || (PGSSL_CA_B64 ? Buffer.from(PGSSL_CA_B64, 'base64').toString('utf8') : '');
  if (!caPem) {
    console.error('[config] PGSSL=verify_full but no PGSSL_CA/PGSSL_CA_B64 provided');
    process.exit(1);
  }
  ssl = { ca: caPem }; // node-postgres enables TLS when 'ssl' is an object
} else {
  ssl = false; // (will fail on DO)
}
console.log('[db] init', { mode: PGSSL, hasPem: !!PGSSL_CA, hasB64: !!PGSSL_CA_B64 });

const pool = new Pool({ connectionString: DATABASE_URL, ssl });

// ===== Helpers =====
const nowIso = () => new Date().toISOString();
function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// μ-law near-silence gate
function isMostlySilenceULaw(b64, ratio = 0.92) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return true;
  let near = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0xFF || b === 0x7F || b >= 0xFD) near++;
  }
  return (near / buf.length) >= ratio;
}

// DB: load agent row
async function loadAgent(agentId) {
  const { rows } = await pool.query(
    `SELECT
       id, display_name, system_message,
       openai_api_key, eleven_api_key, eleven_voice_id, eleven_model_id,
       pipedream_url, pipedream_auth,
       twilio_account_sid, twilio_auth_token, agent_number,
       vad_threshold, vad_prefix_padding_ms, vad_silence_duration_ms,
       tts_speed, tts_stability, tts_similarity_boost
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
/** callCtx[callSid] = { agentId, agentRow, callerFrom } */
const callCtx = new Map();

// ===== Twilio REST helpers (use agent's creds from DB) =====
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
    if (!res.ok) console.error('[twilio] hangup failed', res.status, await res.text());
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
    return await res.json().catch(() => null);
  } catch (e) { console.error('[twilio] start recording error', e); return null; }
}

async function fetchFromNumberViaRest(callSid, twilioSid, twilioToken) {
  if (!twilioSid || !twilioToken || !callSid) return '';
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Calls/${callSid}.json`;
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString('base64');
  try {
    const res  = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return '';
    const json = await res.json();
    return json.from_formatted || json.from || '';
  } catch { return ''; }
}

async function postCaptureToPipedream(payload, captureUrl, captureAuth) {
  if (!captureUrl) return;
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (captureAuth) headers['Authorization'] = `Bearer ${captureAuth}`;
    await fetch(captureUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) { console.error('[capture] error', e); }
}

// ===== Health =====
fastify.get('/healthz', async (_req, reply) => reply.send({ ok: true, t: nowIso() }));
fastify.get('/db-ping', async (_req, reply) => {
  await pool.query('select 1');
  reply.send({ ok: 1, mode: PGSSL, hasPem: !!PGSSL_CA, hasB64: !!PGSSL_CA_B64, t: new Date().toISOString() });
});
fastify.get('/', async (_req, reply) => reply.send({ message: 'Twilio Media Stream Server is running!' }));

// ===== TwiML: transfer (resolve by CallSid from memory) =====
fastify.all('/transfer', async (req, reply) => {
  const callSid = req.body?.CallSid || req.query?.CallSid || '';
  const ctx = callCtx.get(callSid);
  const agent = ctx?.agentRow;

  if (!agent) {
    reply.type('text/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Transfer unavailable.</Say></Response>`);
    return;
  }
  if (!agent.agent_number) {
    reply.type('text/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Transfer number not configured.</Say></Response>`);
    return;
  }

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>${xmlEscape(agent.agent_number)}</Dial>
</Response>`;
  reply.type('text/xml; charset=utf-8').send(twiml);
});

// ===== TwiML: incoming-call (NO <Parameter> tags to avoid XML parse issues) =====
fastify.all('/incoming-call/:agentId', async (request, reply) => {
  const { agentId } = request.params;
  const from    = request.body?.From    || request.query?.From    || '';
  const callSid = request.body?.CallSid || request.query?.CallSid || '';
  const host    = request.headers['x-forwarded-host'] || request.headers.host;

  console.log('[twiml] /incoming-call', { agentId, from, callSid, host });

  const agent = await loadAgent(agentId);
  if (!agent) {
    reply.type('text/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Agent not found.</Say></Response>`);
    return;
  }
  const miss = missingFields(agent);
  if (miss.length) {
    console.error('[twiml] agent misconfigured', agentId, 'missing:', miss);
    reply.type('text/xml; charset=utf-8')
      .send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Agent misconfigured.</Say></Response>`);
    return;
  }

  // Cache context for the WS start event to retrieve by CallSid
  if (callSid) callCtx.set(callSid, { agentId, agentRow: agent, callerFrom: from });

  const wsUrl = `wss://${host}/media-stream`; // NO query string, NO <Parameter> tags
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${xmlEscape(wsUrl)}"/>
  </Connect>
</Response>`;

  reply.type('text/xml; charset=utf-8').send(twimlResponse);
});

// ===== Recording status =====
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
const LOG_EVENT_TYPES = [
  'error','rate_limits.updated','session.created','session.updated',
  'response.created','response.output_text.delta','response.output_text.done','response.done',
  'input_audio_buffer.speech_started','input_audio_buffer.speech_stopped','input_audio_buffer.committed'
];

fastify.register(async (app) => {
  app.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('[ws] Twilio connected');

    // Per-connection state
    let streamSid = null;
    let callSid   = null;
    let baseHost  = req.headers['x-forwarded-host'] || req.headers.host || '';
    let callerFrom = null;

    // Resolved agent
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
    const TRANSFER_TOKEN = '<TRANSFER_AGENT>';
    const CAPTURE_JSON_START = '[[CAPTURE_JSON]]';
    const CAPTURE_JSON_END   = '[[/CAPTURE_JSON]]';

    let endTokenSeen = false;
    let captureTokenSeen = false;
    let capturePosted = false;
    let transferTokenSeen = false;

    let textTail = '';
    let scanBuf = '';
    let captureJson = null;
    let captureJsonReady = false;

    // Eleven
    let elevenWs = null;
    let elevenOpen = false;
    const elevenQueue = [];
    let elevenPing = null;
    let suppressTts = false;

    const maxTokenLen = Math.max(
      END_TOKEN.length, CAPTURE_TOKEN.length, CAPTURE_JSON_START.length, CAPTURE_JSON_END.length, TRANSFER_TOKEN.length
    );

    function escapeForRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function sendMark() { if (streamSid) connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } })); }
    function checkAndHandleTokens(combined) {
      if (!captureTokenSeen && combined.includes(CAPTURE_TOKEN)) captureTokenSeen = true;
      if (!endTokenSeen && combined.includes(END_TOKEN)) endTokenSeen = true;
      if (!transferTokenSeen && combined.includes(TRANSFER_TOKEN)) transferTokenSeen = true;
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
        try { captureJson = JSON.parse(raw); captureJsonReady = true; }
        catch { /* ignore parse error */ }
      }
      if (scanBuf.length > 8000) scanBuf = scanBuf.slice(-4000);
    }

    // ===== ElevenLabs (from agent row) =====
    function createElevenSocket(xiKey, voiceId, modelId) {
      const url =
        `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
        `?model_id=${encodeURIComponent(modelId)}&output_format=ulaw_8000&auto_mode=true`;
      const ws = new WebSocket(url, { headers: { 'xi-api-key': xiKey } });
      ws.binaryType = 'nodebuffer';
      return ws;
    }
    function flushElevenQueue() {
      if (!elevenOpen || !elevenWs) return;
      while (elevenQueue.length) {
        const frame = elevenQueue.shift();
        try { elevenWs.send(JSON.stringify(frame)); }
        catch (e) { console.error('[eleven] send error while flushing', e); break; }
      }
    }
    function sendToEleven(frame) { elevenQueue.push(frame); if (elevenOpen) flushElevenQueue(); }
    function ensureEleven() {
      if (elevenWs && elevenOpen) return;
      if (elevenWs && !elevenOpen) return;
      if (!agent?.eleven_api_key || !agent?.eleven_voice_id) { console.error('[eleven] missing keys/voice'); return; }

      elevenWs = createElevenSocket(agent.eleven_api_key, agent.eleven_voice_id, agent.eleven_model_id || 'eleven_turbo_v2_5');
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
        console.log('[eleven] WS open');
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
        } catch (e) { console.error('[eleven] message forward error', e); }
      });
      elevenWs.on('close', () => { elevenOpen = false; });
      elevenWs.on('error', (e) => { console.error('[eleven] WS error', e); });
    }

    // ===== OpenAI Realtime (from agent row) =====
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
        openAi.send(JSON.stringify(sessionUpdate));

        // Initial greeting
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
          if (LOG_EVENT_TYPES.includes(msg.type)) console.log('[ai]', msg.type);

          if (msg.type === 'response.created') {
            activeResponseId = msg.response?.id || null;
            isResponseInProgress = true;
            sawTextDelta = false;
            suppressTts = false;
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
          }

          if (msg.type === 'response.output_text.done' && typeof msg.text === 'string' && msg.text.length && !sawTextDelta) {
            const textRaw = msg.text;
            scanBuf += textRaw; tryParseCaptureJsonBlocks();
            const text = stripNonSpoken(textRaw);
            if (text) { ensureEleven(); sendToEleven({ text, try_trigger_generation: true }); isTtsSpeaking = true; }
          }

          if (msg.type === 'response.done') {
            if (!sawTextDelta) {
              // Try to extract any final text (defensive)
              const out = msg?.response?.output;
              let final = '';
              if (Array.isArray(out)) {
                for (const item of out) {
                  if (item?.type === 'message' && Array.isArray(item.content)) {
                    for (const c of item.content) {
                      if ((c?.type === 'output_text' || c?.type === 'text') && typeof c?.text === 'string') {
                        final += (final ? ' ' : '') + c.text;
                      }
                    }
                  }
                }
              }
              if (final) {
                scanBuf += final; tryParseCaptureJsonBlocks();
                const cleaned = stripNonSpoken(final);
                if (cleaned) { ensureEleven(); sendToEleven({ text: cleaned, try_trigger_generation: true }); isTtsSpeaking = true; }
              }
            }

            if (isTtsSpeaking) sendToEleven({ flush: true });
            isTtsSpeaking = false;

            // One-time capture post
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
          }

          if (msg.type === 'input_audio_buffer.speech_started') {
            suppressTts = true;
            if (isResponseInProgress) {
              try { openAi.send(JSON.stringify({ type: 'response.cancel' })); } catch {}
            }
            connection.send(JSON.stringify({ event: 'clear', streamSid }));
          }
          if (msg.type === 'input_audio_buffer.speech_stopped') {
            suppressTts = false;
          }
        } catch (e) {
          console.error('Error processing OpenAI message:', e, 'Raw:', data?.toString?.().slice(0,200));
        }
      });

      openAi.on('close', () => { console.log('[ai] ws close'); });
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
            baseHost  = req.headers['x-forwarded-host'] || req.headers.host || baseHost;

            // Resolve agent from memory by CallSid (populated in /incoming-call)
            const cached = callCtx.get(callSid);
            agent = cached?.agentRow || null;
            callerFrom = cached?.callerFrom || null;

            if (!agent) {
              console.error('[start] agent not found for CallSid', callSid);
              return;
            }
            const miss = missingFields(agent);
            if (miss.length) {
              console.error('[start] agent misconfigured', agent.id, 'missing:', miss);
              return;
            }

            // Start recording
            const recCb = baseHost ? `https://${baseHost}/recording-status/${encodeURIComponent(agent.id)}` : '';
            startCallRecording(callSid, recCb, agent.twilio_account_sid, agent.twilio_auth_token);

            // Create OpenAI session (also triggers greeting)
            createAndWireOpenAi();

            console.log('[twilio] stream start', { agentId: agent.id, streamSid, callSid, from: callerFrom || '(unknown)', host: baseHost || '(empty)' });
            break;
          }

          case 'media': {
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
            // mark, etc.
            break;
        }
      } catch (e) {
        console.error('Error parsing Twilio message:', e, 'Message:', message?.toString?.().slice(0,200));
      }
    });

    // Cleanup
    connection.on('close', () => {
      try { if (openAiWs && openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
      try { if (elevenWs && elevenWs.readyState === WebSocket.OPEN) elevenWs.close(); } catch {}
      if (elevenPing) { clearInterval(elevenPing); elevenPing = null; }
      if (callSid) callCtx.delete(callSid);
      console.log('[ws] client disconnected.');
    });
  });
});

// Start server
const host = '0.0.0.0';
fastify.listen({ port: PORT, host }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`[${nowIso()}] Server is listening on ${address}`);
});
