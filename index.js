import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

dotenv.config();

const {
  OPENAI_API_KEY,
  XI_API_KEY,
  ELEVEN_VOICE_ID,
  ELEVEN_MODEL_ID = 'eleven_turbo_v2_5',
  // Twilio creds to end/redirect the call
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  // where to send capture events
  PIPEDREAM_URL,
  PIPEDREAM_AUTH, // optional: Bearer token
  // target phone number for transfer (E.164)
  AGENT_NUMBER,   // e.g. +15551234567
} = process.env;

if (!OPENAI_API_KEY) { console.error('Missing OPENAI_API_KEY'); process.exit(1); }
if (!XI_API_KEY) { console.error('Missing XI_API_KEY'); process.exit(1); }
if (!ELEVEN_VOICE_ID) { console.error('Missing ELEVEN_VOICE_ID'); process.exit(1); }

const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

const PORT = process.env.PORT || 5050;

// ===== Tokens / Markers =====
const END_TOKEN = '<END_CALL>';             // when heard → hang up
const CAPTURE_TOKEN = '<CAPTURE_JOB>';      // when heard → POST to Pipedream
const CAPTURE_JSON_START = '[[CAPTURE_JSON]]';
const CAPTURE_JSON_END   = '[[/CAPTURE_JSON]]';
const TRANSFER_TOKEN = '<TRANSFER_AGENT>';  // when heard → transfer the call

// ===== System prompt =====
const SYSTEM_MESSAGE = `
You are a phone agent for a towing service.

On the first turn only, greet with exactly: "Hello, thank you for calling Word towing services, how can I help you ?".
After the greeting, do not greet again. Keep each turn ≤ 2 sentences and stop talking if the caller interrupts.
Do not collect passwords or full card numbers. No medical/emergency handling.

Determine whether the caller needs:
- Tow truck service, OR
- Roadside assistance (formerly jump start), OR
- Is calling on behalf of an insurance company.

For Tow truck or Roadside assistance:
- Ask for the car make and model.
- Ask where the car is located.
- Ask if they are with the car currently (capture their exact words, e.g., “my friend is with it”, “I’m on the way”, “no one is there”, “not sure”).
- Ask what is wrong with the car.
- Ask if the car can be put in neutral (capture their exact words, e.g., “yes”, “no”, “not sure”). - (do not ask for neutral if it is roadside assistance)
- Ask where the car needs to be towed to. - (do not ask for destination if it is roadside assistance)

Then confirm the service and cost:
- For tow truck: say
  "Thanks for all that information. The estimated wait time for the tow truck to arrive is forty-five minutes, and the cost for the tow truck service will be 100$ plus 10$ per mile towed, will that work for you?"
- For roadside assistance: say
  "Thanks for all that information. The estimated wait time for the roadside assistance to arrive is forty-five minutes, and the cost for basic roadside assistance will be 200 dollars, will that work for you?"

If they accept:
- Acknowledge the dispatch with a short, friendly closing.
- Then ask for the caller’s name.
- Then ask for the caller’s phone number and repeat it back for confirmation.
- **Only after you have both name and phone**, append <CAPTURE_JOB> and output the JSON block (below) on the next line.
- After that, ask ONE short follow-up question like "Anything else I can help with?" and wait for the caller’s next turn.

If they decline:
- Treat a bare “no”/“no thanks”/“nah” ONLY as declining dispatch (not ending the call).
- You MUST say exactly:
  "Ok. If you decide to have us dispatch towing truck for you, just give us a call back. Thank you for calling Word Towing service. Again, my name is Jessica and I hope that you have a great rest of your day."
- **Immediately after that sentence**, append <CAPTURE_JOB> and output the JSON block (below) with "name": "" and "phone": "".
- Then ask ONE short follow-up question (e.g., "Is there anything else I can help you with?").

FAQ mini-answers:
- If they ask for price/cost: "Cost for the tow truck service will be 100$ plus 10$ per mile towed."
- If they ask for wait time: "Wait time is 45 minutes."

Capture protocol (do not mention tokens or JSON):
- Emit the capture exactly ONCE per call.
- Accept path: append <CAPTURE_JOB> only after collecting and confirming caller’s name and phone.
- Decline path: append <CAPTURE_JOB> immediately after the decline script, with name and phone set to "".
- On the NEXT line (for either path), output EXACTLY this JSON block, wrapped in the markers shown below (valid, double-quoted JSON; no extra keys):

[[CAPTURE_JSON]]
{
  "decision": "accept",
  "service": "tow",
  "car_model": "<make and model in caller's words>",
  "location": { "raw": "<location in caller's words or empty>" },
  "with_car": "<exact words or empty>",
  "issue": "<exact words or empty>",
  "neutral_status": "<exact words or empty>",
  "destination": "<exact words or empty>",
  "name": "<caller name or empty>",
  "phone": "<caller phone or empty>"
}
[[/CAPTURE_JSON]]

- Replace the example values above. If the decision is a decline, set "decision": "decline" and set "name" and "phone" to "".
- Do NOT speak or describe the JSON. Do NOT add extra keys. Use "" for unknowns.
- After you have emitted <CAPTURE_JOB> once, NEVER emit it again.

If the caller asks to speak with a live agent, say one short sentence such as "I will transfer you now" and append the exact token <TRANSFER_AGENT> at the very end of your reply. Never say the words "transfer agent" aloud.

Closing protocol (strict):
- Only after the caller’s subsequent turn clearly ends the conversation (e.g., "no, that’s all", "nothing else", "bye"), reply with a very short farewell (1–5 words, e.g., "Goodbye.") and append <END_CALL> as the last characters.
- Never put <END_CALL> in the same reply as the decline script, dispatch acknowledgement, or first goodbye.
`;

// ===== Helpers / logging =====
const LOG_EVENT_TYPES = [
  'error','rate_limits.updated','session.created','session.updated',
  'response.created','response.output_text.delta','response.output_text.done','response.done',
  'input_audio_buffer.speech_started','input_audio_buffer.speech_stopped','input_audio_buffer.committed'
];
const nowIso = () => new Date().toISOString();

// μ-law near-silence gate to drop hiss/line noise (Twilio G.711 μ-law).
function isMostlySilenceULaw(b64, ratio = 0.92) {
  const buf = Buffer.from(b64, 'base64');
  if (buf.length === 0) return true;
  let near = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0xFF || b === 0x7F || b >= 0xFD) near++; // 0xFF=μ-law silence; 0x7F=minus-zero
  }
  return (near / buf.length) >= ratio;
}

function xmlEscape(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
}

// Twilio REST: hang up the live call
async function hangupCall(callSid) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.warn('[twilio] Hangup requested but TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN not set.');
    return;
  }
  if (!callSid) {
    console.warn('[twilio] Hangup requested but callSid is missing.');
    return;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const body = new URLSearchParams({ Status: 'completed' });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const txt = await res.text();
    if (!res.ok) {
      console.error('[twilio] Hangup failed', res.status, txt);
    } else {
      console.log('[twilio] Hangup requested for CallSid', callSid);
    }
  } catch (e) {
    console.error('[twilio] Hangup error', e);
  }
}

// Twilio REST: redirect a live call to /transfer (which dials AGENT_NUMBER)
async function transferCall(callSid, baseUrl) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.warn('[twilio] Transfer requested but missing creds.');
    return;
  }
  if (!callSid) {
    console.warn('[twilio] Transfer requested but callSid missing.');
    return;
  }
  if (!AGENT_NUMBER) {
    console.warn('[twilio] Transfer requested but AGENT_NUMBER is not set.');
    return;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const twimlUrl = `https://${baseUrl}/transfer`; // our TwiML route
  const body = new URLSearchParams({ Url: twimlUrl });
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body
    });
    const txt = await res.text();
    if (!res.ok) {
      console.error('[twilio] Transfer failed', res.status, txt);
    } else {
      console.log('[twilio] Transfer requested for CallSid', callSid, 'to', AGENT_NUMBER);
    }
  } catch (e) {
    console.error('[twilio] Transfer error', e);
  }
}

async function fetchFromNumberViaRest(callSid) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return '';
  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');
  try {
    const res  = await fetch(url, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) { console.error('[twilio] calls fetch failed', res.status); return ''; }
    const json = await res.json();
    // Twilio returns "+15551234567" under "from" or "from_formatted" depending on account region.
    return json.from_formatted || json.from || '';
  } catch (e) {
    console.error('[twilio] calls fetch error', e);
    return '';
  }
}

// Start call recording via REST (dual channel) and optional status callback
async function startCallRecording(callSid, callbackUrl) {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !callSid) return null;

  const url  = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`;
  const auth = Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64');

  const body = new URLSearchParams({
    RecordingChannels: 'dual',
    RecordingTrack: 'both',
    Trim: 'trim-silence',
    ...(callbackUrl ? {
      RecordingStatusCallback: callbackUrl,
      RecordingStatusCallbackMethod: 'POST',
      // Twilio will send "in-progress", "completed", "absent"
    } : {})
  });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    if (!res.ok) {
      console.error('[twilio] start recording failed', res.status, await res.text());
      return null;
    }
    return await res.json().catch(() => null);
  } catch (e) {
    console.error('[twilio] start recording error', e);
    return null;
  }
}

// Pipedream POST
async function postCaptureToPipedream(payload) {
  if (!PIPEDREAM_URL) {
    console.warn('[pipedream] PIPEDREAM_URL is not set; skipping POST.');
    return;
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (PIPEDREAM_AUTH) headers['Authorization'] = `Bearer ${PIPEDREAM_AUTH}`;
    console.log('[pipedream] POST ->', PIPEDREAM_URL, 'payload:', payload);
    const res = await fetch(PIPEDREAM_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log('[pipedream] response', res.status, text);
  } catch (e) {
    console.error('[pipedream] error', e);
  }
}

// ===== Health =====
fastify.get('/healthz', async (_req, reply) => reply.send({ ok: true, t: nowIso() }));
fastify.get('/', async (_req, reply) => reply.send({ message: 'Twilio Media Stream Server is running!' }));

// TwiML route to dial your live agent number
fastify.all('/transfer', async (_req, reply) => {
  if (!AGENT_NUMBER) {
    reply.type('text/xml').send(`<?xml version="1.0" encoding="UTF-8"?><Response><Say>Agent number not configured.</Say></Response>`);
    return;
  }
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial>${xmlEscape(AGENT_NUMBER)}</Dial>
</Response>`;
  reply.type('text/xml').send(twiml);
});

// Twilio webhook: silent connect; also pass From/CallSid into Stream params (so we can read them in the WS 'start' event)
// TwiML: incoming-call → connect media stream and pass params
fastify.all('/incoming-call', async (request, reply) => {
  // Twilio posts application/x-www-form-urlencoded; fastifyFormBody parses it.
  const from    = request.body?.From    || request.query?.From    || '';
  const callSid = request.body?.CallSid || request.query?.CallSid || '';
  const host    = request.headers['x-forwarded-host'] || request.headers.host;

  // Log what we *plan* to pass into <Parameter/>
  console.log('[twiml] /incoming-call params', { from, callSid, host });

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream">
      <Parameter name="from" value="${xmlEscape(from)}"/>
      <Parameter name="callSid" value="${xmlEscape(callSid)}"/>
      <Parameter name="host" value="${xmlEscape(host)}"/>
    </Stream>
  </Connect>
</Response>`;
  reply.type('text/xml').send(twimlResponse);
});



fastify.post('/recording-status', async (req, reply) => {
  const { CallSid, RecordingSid, RecordingStatus, RecordingUrl } = req.body || {};
  if (RecordingStatus === 'completed' && RecordingSid && RecordingUrl) {
    // Downloadable link (mp3) + dual channels
    const url = `${RecordingUrl}.mp3?RequestedChannels=2`;
    console.log('[recording] completed', { callSid: CallSid, recordingSid: RecordingSid, url });
  } else {
    // Optional: keep a breadcrumb for other statuses
    console.log('[recording-status]', { CallSid, RecordingSid, RecordingStatus });
  }
  reply.send('ok');
});


// ===== ElevenLabs WebSocket client (ulaw_8000) =====
function createElevenSocket(voiceId, modelId) {
  const url =
    `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input` +
    `?model_id=${encodeURIComponent(modelId)}&output_format=ulaw_8000&auto_mode=true`;

  const ws = new WebSocket(url, { headers: { 'xi-api-key': XI_API_KEY } });
  ws.binaryType = 'nodebuffer';
  return ws;
}

// ===== Media Stream route =====
fastify.register(async (app) => {
  app.get('/media-stream', { websocket: true }, (connection, req) => {
    console.log('Client connected');

    // Per-connection state
    let streamSid = null;
    let callSid = null;
    let callerFrom = null; // +E.164 phone
    let baseHost = null;   // host for building /transfer URL
    let latestMediaTimestamp = 0;

    let activeResponseId = null;
    let isResponseInProgress = false;
    let isTtsSpeaking = false;
    let sawTextDelta = false;
    let didRetryThisTurn = false;
    let greeted = false;
    let sessionReady = false;
    let sessionId = null;

    // End/Capture/Transfer tracking
    let endTokenSeen = false;
    let captureTokenSeen = false;
    let capturePosted = false;
    let transferTokenSeen = false;

    // Streaming text helpers
    let textTail = '';
    let scanBuf = ''; // rolling buffer to find CAPTURE_JSON across deltas
    let captureJson = null; // parsed JSON once found
    let captureJsonReady = false; // post even if token missing when JSON is ready

    // NEW: suppress TTS forwarding during barge-in
    let suppressTts = false;

    const maxTokenLen = Math.max(
      END_TOKEN.length,
      CAPTURE_TOKEN.length,
      CAPTURE_JSON_START.length,
      CAPTURE_JSON_END.length,
      TRANSFER_TOKEN.length
    );

    // OpenAI Realtime (TEXT ONLY)
    const openAiWs = new WebSocket(
      'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
    );

    // ElevenLabs WS + queue
    let elevenWs = null;
    let elevenOpen = false;
    const elevenQueue = [];
    let elevenPing = null;

    function flushElevenQueue() {
      if (!elevenOpen || !elevenWs) return;
      while (elevenQueue.length) {
        const frame = elevenQueue.shift();
        try { elevenWs.send(JSON.stringify(frame)); }
        catch (e) { console.error('[eleven] send error while flushing', e); break; }
      }
    }

    function sendToEleven(frame) {
      elevenQueue.push(frame);
      if (elevenOpen) flushElevenQueue();
    }

    function ensureEleven() {
      if (elevenWs && elevenOpen) return;
      if (elevenWs && !elevenOpen) return;

      elevenWs = createElevenSocket(ELEVEN_VOICE_ID, ELEVEN_MODEL_ID);
      elevenOpen = false;

      elevenWs.on('open', () => {
        console.log('[eleven] WS open');
        elevenOpen = true;
        // slightly snappier defaults
        sendToEleven({ text: ' ', voice_settings: { speed: 1.05, stability: 0.45, similarity_boost: 0.85 } });
        flushElevenQueue();
        if (!elevenPing) {
          elevenPing = setInterval(() => { try { elevenWs.ping(); } catch {} }, 20000);
        }
      });

      elevenWs.on('message', (data, isBinary) => {
        try {
          if (isBinary) {
            if (suppressTts) return; // drop audio during barge-in
            const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
            if (streamSid) connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: b64 } }));
            return;
          }
          const msg = JSON.parse(data.toString());
          if (msg.audio && streamSid && !suppressTts) {
            connection.send(JSON.stringify({ event: 'media', streamSid, media: { payload: msg.audio } }));
          }
        } catch (e) { console.error('Eleven message parse/forward error', e); }
      });

      elevenWs.on('close', (code, reasonBuf) => {
        const reason = reasonBuf ? reasonBuf.toString() : '';
        const idleTimeout = code === 1008 && reason.startsWith('Have not received a new text input');
        if (!idleTimeout) console.warn('[eleven] WS closed', { code, reason });
        else console.log('[eleven] WS closed (idle timeout)');
        elevenOpen = false;
      });

      elevenWs.on('unexpected-response', (req, res) => {
        console.error('[eleven] unexpected-response:', res.statusCode, res.statusMessage);
        let buf = ''; res.on('data', d => { buf += d.toString(); });
        res.on('end', () => console.error('[eleven] body:', buf));
      });

      elevenWs.on('error', (e) => console.error('[eleven] WS error', e));
    }

    function sendMark() {
      if (!streamSid) return;
      connection.send(JSON.stringify({ event: 'mark', streamSid, mark: { name: 'responsePart' } }));
    }

    function extractFinalTextFromResponseDone(resp) {
      try {
        const out = resp?.output;
        if (!Array.isArray(out)) return '';
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

    function initializeOpenAiSession() {
      const sessionUpdate = {
        type: 'session.update',
        session: {
          // ⚡ Lower-latency VAD tuning
          turn_detection: { type: 'server_vad', threshold: 0.70, prefix_padding_ms: 300, silence_duration_ms: 320, create_response: true, interrupt_response: true },
          input_audio_noise_reduction: { type: 'near_field' },
          input_audio_format: 'g711_ulaw',
          modalities: ['text'],
          instructions: SYSTEM_MESSAGE,
          temperature: 0.8
        }
      };
      console.log('Sending session update:', JSON.stringify(sessionUpdate));
      openAiWs.send(JSON.stringify(sessionUpdate));
    }

    function sendInitialGreeting() {
      console.log('[ai] sending initial greeting');
      openAiWs.send(JSON.stringify({
        type: 'response.create',
        response: {
          modalities: ['text'],
          instructions: 'Greet the caller now with exactly: "Hello, thank you for calling Word towing services, how can I help you ?" Then wait for the caller.'
        }
      }));
      greeted = true;
    }

    function escapeForRegex(s) {
      return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function checkAndHandleTokens(combined) {
      if (combined.includes(CAPTURE_TOKEN)) captureTokenSeen = true;
      if (combined.includes(END_TOKEN)) endTokenSeen = true;
      if (combined.includes(TRANSFER_TOKEN)) transferTokenSeen = true;
    }

    function stripNonSpoken(text) {
      // remove tokens
      let out = text
        .replaceAll(CAPTURE_TOKEN, '')
        .replaceAll(END_TOKEN, '')
        .replaceAll(TRANSFER_TOKEN, '');
      // remove any CAPTURE_JSON block if fully present inside this chunk
      const reBlock = new RegExp(
        escapeForRegex(CAPTURE_JSON_START) + '[\\s\\S]*?' + escapeForRegex(CAPTURE_JSON_END),
        'g'
      );
      out = out.replace(reBlock, '');
      // also remove naked markers if they appear alone
      out = out.replaceAll(CAPTURE_JSON_START, '').replaceAll(CAPTURE_JSON_END, '');
      return out;
    }

    // Try to parse CAPTURE_JSON blocks from scanBuf (handles across-delta streaming)
    function tryParseCaptureJsonBlocks() {
      if (captureJson || capturePosted) return; // already captured or posted
      let startIdx = scanBuf.indexOf(CAPTURE_JSON_START);
      let endIdx = scanBuf.indexOf(CAPTURE_JSON_END, startIdx + CAPTURE_JSON_START.length);
      if (startIdx !== -1 && endIdx !== -1) {
        const raw = scanBuf.substring(startIdx + CAPTURE_JSON_START.length, endIdx).trim();
        // Remove the block from scanBuf to prevent re-parsing
        scanBuf = scanBuf.slice(0, startIdx) + scanBuf.slice(endIdx + CAPTURE_JSON_END.length);
        try {
          const obj = JSON.parse(raw);
          captureJson = obj;
          captureJsonReady = true; // mark ready even if token is missing
          console.log('[capture] Parsed CAPTURE_JSON:', obj);
        } catch (e) {
          console.warn('[capture] Failed to parse CAPTURE_JSON:', e, 'raw:', raw);
        }
      }
      // keep buffer from growing without bounds
      if (scanBuf.length > 8000) scanBuf = scanBuf.slice(-4000);
    }

    // ---- OpenAI WS handlers ----
    openAiWs.on('open', () => {
      console.log('Connected to the OpenAI Realtime API');
      initializeOpenAiSession();
    });

    openAiWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (LOG_EVENT_TYPES.includes(msg.type)) console.log(`Received event: ${msg.type}`, msg);

        if (msg.type === 'session.created') {
          sessionId = msg.session?.id || null;
        }

        if (msg.type === 'session.updated' && !sessionReady) {
          sessionReady = true;
          ensureEleven();
          const waitAndGreet = () => {
            if (elevenOpen && !greeted) { sendInitialGreeting(); }
            else if (!greeted) { setTimeout(waitAndGreet, 50); }
          };
          waitAndGreet();
        }

        if (msg.type === 'response.created') {
          activeResponseId = msg.response?.id || null;
          isResponseInProgress = true;
          sawTextDelta = false;
          suppressTts = false; // allow TTS for this response
        }

        // Stream text to Eleven as deltas arrive (strip tokens & JSON; detect across boundaries)
        if (msg.type === 'response.output_text.delta' && typeof msg.delta === 'string') {
          const deltaRaw = msg.delta;
          scanBuf += deltaRaw;             // accumulate raw for JSON parsing
          tryParseCaptureJsonBlocks();

          let deltaSpeak = deltaRaw;
          const combined = (textTail + deltaRaw);
          checkAndHandleTokens(combined);
          deltaSpeak = stripNonSpoken(deltaSpeak);
          textTail = combined.slice(-Math.max(1, maxTokenLen - 1));
          sawTextDelta = true; // ✅ fix: mark that we saw streaming content

          if (deltaSpeak) {
            ensureEleven();
            sendToEleven({ text: deltaSpeak, try_trigger_generation: true });
            isTtsSpeaking = true;
            sendMark();
          }
        }

        // If no deltas, use output_text.done (also check JSON there)
        if (msg.type === 'response.output_text.done' && typeof msg.text === 'string' && msg.text.length && !sawTextDelta) {
          const textRaw = msg.text;
          scanBuf += textRaw;
          tryParseCaptureJsonBlocks();

          let text = textRaw;
          checkAndHandleTokens(text);
          text = stripNonSpoken(text);
          if (text) {
            ensureEleven();
            sendToEleven({ text, try_trigger_generation: true });
            isTtsSpeaking = true;
          }
        }

        // Response finished → FLUSH Eleven to push remaining audio
        if (msg.type === 'response.done') {
          if (!sawTextDelta) {
            const finalTextRaw = extractFinalTextFromResponseDone(msg.response);
            if (finalTextRaw) {
              scanBuf += finalTextRaw;
              tryParseCaptureJsonBlocks();

              let cleaned = finalTextRaw;
              checkAndHandleTokens(cleaned);
              cleaned = stripNonSpoken(cleaned);
              if (cleaned) {
                ensureEleven();
                sendToEleven({ text: cleaned, try_trigger_generation: true });
                isTtsSpeaking = true;
              }
            } else {
              console.warn('No text found in response.done output');
            }
          }

          if (isTtsSpeaking) sendToEleven({ flush: true }); // keep explicit flush
          isTtsSpeaking = false;

          // If CAPTURE token seen OR JSON parsed, POST once
          if ((captureTokenSeen || captureJsonReady) && !capturePosted) {
            capturePosted = true;
            const payload = {
              type: 'tow_capture',
              at: nowIso(),
              callSid,
              from: callerFrom,
              job: captureJson || null, // parsed JSON if present
            };
            console.log('[capture] Posting capture. tokenSeen:', captureTokenSeen, 'jsonReady:', captureJsonReady, 'payload:', payload);
            postCaptureToPipedream(payload);

            // prevent future re-posts this call
            captureTokenSeen = false;
            captureJsonReady = false;
            captureJson = null;
            scanBuf = '';
          }

          // If TRANSFER token seen, request transfer (delay so TTS can finish)
          if (transferTokenSeen) {
            transferTokenSeen = false;
            const host = baseHost || req.headers['x-forwarded-host'] || req.headers.host;
            console.log('[call] TRANSFER_TOKEN detected; transferring to agent.');
            setTimeout(() => { transferCall(callSid, host); }, 3000);
          }

          // If END_TOKEN seen, hang up after a short delay (let last audio egress)
          if (endTokenSeen) {
            console.log('[call] END_TOKEN detected; scheduling hangup.');
            setTimeout(() => {
              hangupCall(callSid);
              try { connection.close(); } catch {}
            }, 3000);
          }

          isResponseInProgress = false;
          activeResponseId = null;
          sawTextDelta = false;
          textTail = '';

          // Clear input buffer for the next user turn
          try { openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' })); } catch {}

          if (msg.response?.status === 'failed') {
            const err = msg.response?.status_details?.error || {};
            console.error('Realtime failed:', err.type, err.message, 'session:', sessionId);

            isResponseInProgress = false;
            activeResponseId = null;
            sawTextDelta = false;

            try { openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' })); } catch {}

            if (!didRetryThisTurn) {
              didRetryThisTurn = true;
              try {
                openAiWs.send(JSON.stringify({
                  type: 'response.create',
                  response: { modalities: ['text'], instructions: 'Sorry, I had a hiccup. Could you please repeat that last part?' }
                }));
              } catch {}
            }
          } else {
            didRetryThisTurn = false;
            try { openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.clear' })); } catch {}
          }
        }

        // Barge-in
        if (msg.type === 'input_audio_buffer.speech_started') {
          // Stop forwarding Eleven audio immediately
          suppressTts = true;
          // Cancel any in-flight response
          if (isResponseInProgress) {
            try { openAiWs.send(JSON.stringify({ type: 'response.cancel' })); } catch {}
          }
          // Flush Twilio's current audio buffer
          connection.send(JSON.stringify({ event: 'clear', streamSid }));
        }

        if (msg.type === 'error') {
          console.error('Realtime error:', msg.error);
        }
      } catch (e) {
        console.error('Error processing OpenAI message:', e, 'Raw:', data);
      }
    });

    openAiWs.on('close', () => { console.log('Disconnected from the OpenAI Realtime API'); });
    openAiWs.on('error', (e) => { console.error('Error in the OpenAI WebSocket:', e); });

    // ---- Twilio → OpenAI (caller audio) ----
    connection.on('message', (message) => {
      try {
        const data = JSON.parse(message);

        switch (data.event) {
          case 'connected':
            console.log('Received non-media event: connected');
            break;

case 'start': {
  streamSid = data.start.streamSid;
  callSid   = data.start.callSid || callSid;

  // Parse <Parameter/> values from Twilio Media Streams
  const params = {};
  const raw = data.start?.customParameters ?? data.start?.custom_parameters;

  if (Array.isArray(raw)) {
    for (const p of raw) {
      if (p && typeof p === 'object' && 'name' in p) {
        params[p.name] = p.value ?? '';
      }
    }
  } else if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) params[k] = v ?? '';
  }

  if (params.callSid && !callSid) callSid = params.callSid;
  if (params.from)  callerFrom = params.from;
  if (params.host)  baseHost   = params.host;

  console.log('[twilio] stream start', {
    streamSid,
    callSid,
    from: callerFrom || '(empty)',
    host: baseHost || '(empty)'
  });

  // Fallback: fetch caller number via REST if not present
  if (!callerFrom && callSid) {
    fetchFromNumberViaRest(callSid)
      .then(num => {
        if (num) {
          callerFrom = num;
          console.log('[twilio] recovered From via REST', callerFrom);
        } else {
          console.warn('[twilio] From still empty after REST fetch');
        }
      })
      .catch(e => console.error('[twilio] fetch From via REST error', e));
  }

  // Start recording (dual channel). Completion logs as SID+URL in /recording-status
  const recCb = baseHost ? `https://${baseHost}/recording-status` : '';
  startCallRecording(callSid, recCb);

  latestMediaTimestamp = 0;
  break;
}


          case 'media': {
            latestMediaTimestamp = data.media.timestamp;
            const payload = data.media.payload;
            if (isMostlySilenceULaw(payload)) break;
            if (openAiWs.readyState === WebSocket.OPEN) {
              openAiWs.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: payload }));
            }
            break;
          }

          case 'mark':
            // optional
            break;

          case 'stop':
            console.log('Received non-media event: stop');
            break;

          default:
            console.log('Received non-media event:', data.event);
            break;
        }
      } catch (e) {
        console.error('Error parsing Twilio message:', e, 'Message:', message);
      }
    });

    // Cleanup
    connection.on('close', () => {
      try { if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close(); } catch {}
      try { if (elevenWs && elevenWs.readyState === WebSocket.OPEN) elevenWs.close(); } catch {}
      if (elevenPing) { clearInterval(elevenPing); elevenPing = null; }
      console.log('Client disconnected.');
    });
  });
}); 

// Start server
const host = '0.0.0.0';
fastify.listen({ port: PORT, host }, (err, address) => {
  if (err) { console.error(err); process.exit(1); }
  console.log(`[${nowIso()}] Server is listening on ${address}`);
});
