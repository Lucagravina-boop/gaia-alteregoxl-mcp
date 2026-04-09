// GAIA ALTEREGOXL MCP Server v1.2.1
// Node.js per Render.com

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const app = express();
app.use(express.json());

const WORKER_VERSION = "1.2.1";
const STATION_ID = "DOT_OHIILHBG";
const ALTEREGO_BASE = "https://areariservata.alteregoxl.it";
const ALTEREGO_EMAIL = process.env.ALTEREGO_EMAIL || "";
const ALTEREGO_PASSWORD = process.env.ALTEREGO_PASSWORD || "";

// ============================================================
// HTTP HELPER
// ============================================================

function rawFetch(urlStr, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === "https:" ? https : http;
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === "https:" ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || "GET",
      headers: options.headers || {},
      rejectUnauthorized: false
    };

    const req = mod.request(reqOpts, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });

    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ============================================================
// COOKIE HELPERS
// ============================================================

function extractCookies(headers) {
  const cookies = {};
  const sc = headers["set-cookie"];
  if (!sc) return cookies;
  const arr = Array.isArray(sc) ? sc : [sc];
  for (const c of arr) {
    const match = c.match(/^([^=]+)=([^;]+)/);
    if (match) cookies[match[1]] = match[2];
  }
  return cookies;
}

function mergeCookieString(existing, newCookies) {
  const map = {};
  if (existing) {
    for (const part of existing.split("; ")) {
      const eq = part.indexOf("=");
      if (eq > 0) map[part.substring(0, eq)] = part.substring(eq + 1);
    }
  }
  for (const [k, v] of Object.entries(newCookies)) {
    map[k] = v;
  }
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
}

function getXsrfFromCookieStr(cookieStr) {
  const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/);
  if (match) return decodeURIComponent(match[1]);
  return "";
}

// ============================================================
// LOGIN (3 steps)
// ============================================================

async function loginAlterEgo() {
  // Step 1: GET /login
  const step1 = await rawFetch(`${ALTEREGO_BASE}/login`, {
    headers: { "User-Agent": "GAIA-AlterEgoXL/1.2" }
  });

  const cookies1 = extractCookies(step1.headers);
  const xsrfToken = cookies1["XSRF-TOKEN"] || "";
  const laravelSession = cookies1["laravel_session"] || "";

  if (!xsrfToken) {
    return { cookie: "", ok: false, error: "No XSRF-TOKEN", step1_status: step1.status };
  }

  const csrfToken = decodeURIComponent(xsrfToken);
  let cookieStr = `XSRF-TOKEN=${xsrfToken}; laravel_session=${laravelSession}`;

  // Step 2: POST /login
  const step2 = await rawFetch(`${ALTEREGO_BASE}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookieStr,
      "User-Agent": "GAIA-AlterEgoXL/1.2"
    },
    body: `_token=${encodeURIComponent(csrfToken)}&email=${encodeURIComponent(ALTEREGO_EMAIL)}&password=${encodeURIComponent(ALTEREGO_PASSWORD)}`
  });

  if (step2.status !== 302) {
    return { cookie: "", ok: false, error: "Login POST non 302", status: step2.status };
  }

  const cookies2 = extractCookies(step2.headers);
  cookieStr = mergeCookieString(cookieStr, cookies2);

  // Step 3: Follow redirect to /home
  const location = step2.headers["location"] || `${ALTEREGO_BASE}/home`;
  const step3 = await rawFetch(location, {
    headers: {
      "Cookie": cookieStr,
      "User-Agent": "GAIA-AlterEgoXL/1.2",
      "X-Requested-With": "XMLHttpRequest"
    }
  });

  const cookies3 = extractCookies(step3.headers);
  cookieStr = mergeCookieString(cookieStr, cookies3);

  return {
    cookie: cookieStr,
    xsrfDecoded: getXsrfFromCookieStr(cookieStr),
    ok: true,
    status: step2.status,
    location: location,
    step3_status: step3.status
  };
}

// ============================================================
// AUTHENTICATED FETCH
// ============================================================

async function authFetch(url) {
  const login = await loginAlterEgo();
  if (!login.ok) throw new Error(`Login fallito: ${login.error || "status " + login.status}`);

  const resp = await rawFetch(url, {
    headers: {
      "Cookie": login.cookie,
      "User-Agent": "GAIA-AlterEgoXL/1.2",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": login.xsrfDecoded
    }
  });

  try {
    return JSON.parse(resp.body);
  } catch {
    return { raw: resp.body.substring(0, 500), status: resp.status };
  }
}

// ============================================================
// AUTHENTICATED WRITE
// ============================================================

async function authWrite(url) {
  const login = await loginAlterEgo();
  if (!login.ok) return { success: false, error: `Login fallito: ${login.error}` };

  const resp = await rawFetch(url, {
    headers: {
      "Cookie": login.cookie,
      "User-Agent": "GAIA-AlterEgoXL/1.2",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": login.xsrfDecoded
    }
  });

  let json;
  try { json = JSON.parse(resp.body); } catch { json = null; }
  return { status: resp.status, json, body: resp.body.substring(0, 300) };
}

// ============================================================
// FORMATTERS
// ============================================================

function formatD10(bv) {
  const v = Number(bv);
  if (v < 0) return "N/A";
  if (v === 32768) return "----";
  if (v === 32769) return "N/C";
  let val = v;
  if (val >= 32768) val -= 65536;
  return (val / 10).toFixed(1);
}

function formatBool(bv) { return Number(bv) === 0 ? "OFF" : "ON"; }
function formatSeason(bv) { return Number(bv) === 0 ? "Inverno" : "Estate"; }

function formatForcing(bv) {
  const v = Number(bv);
  if (v === 0) return "Automatico";
  if (v === 1) return "Spenta";
  if (v === 2) return "Economy";
  if (v === 3) return "Comfort";
  return `Sconosciuto (${v})`;
}

function formatZoneMode(bv) {
  const v = Number(bv);
  const mode = v & 0x3;
  let txt = "";
  if (mode === 0) txt = "OFF";
  if (mode === 1) txt = "ANTIGELO";
  if (mode === 2) txt = "ECONOMY";
  if (mode === 3) txt = "COMFORT";
  if (v & 0x4) txt += " (FORZ.)";
  return txt;
}

// ============================================================
// TOOL: leggi_impianto
// ============================================================

async function leggiImpianto() {
  const data = await authFetch(`${ALTEREGO_BASE}/${STATION_ID}/getres?timestamp=`);

  if (!data.Data) {
    return { success: false, error: "Nessun dato ricevuto", raw: data };
  }

  const props = {};
  for (const item of data.Data) {
    props[item.Id] = item.V;
  }

  const result = {
    impianto: {
      stato: props.GLOBAL_ENABLE !== undefined ? formatBool(props.GLOBAL_ENABLE) : "N/D",
      stagione: props.GLOBAL_SEASON !== undefined ? formatSeason(props.GLOBAL_SEASON) : "N/D",
      acs_stato: props.GLOBAL_ACS_ENABLE !== undefined ? formatBool(props.GLOBAL_ACS_ENABLE) : "N/D",
      temp_esterna: props.GLOBAL_T_EXT !== undefined ? formatD10(props.GLOBAL_T_EXT) + " °C" : "N/D",
      temp_acs: props.GLOBAL_T_ACS !== undefined ? formatD10(props.GLOBAL_T_ACS) + " °C" : "N/D",
    },
    zone: [],
    circuiti: [],
    allarmi_attivi: []
  };

  for (let i = 1; i <= 24; i++) {
    const xref = props[`Z${i}_ZONE_XREF`];
    if (xref === undefined || Number(xref) === 0) continue;

    const zone = {
      numero: i,
      modo: props[`Z${i}_ZONE_MODE`] !== undefined ? formatZoneMode(props[`Z${i}_ZONE_MODE`]) : "N/D",
      uscita: props[`Z${i}_OUTPUT`] !== undefined ? formatBool(props[`Z${i}_OUTPUT`]) : "N/D",
      forzatura: props[`Z${i}_FORCING`] !== undefined ? formatForcing(props[`Z${i}_FORCING`]) : "N/D",
    };

    if (props[`Z${i}_TEMP`] !== undefined && Number(props[`Z${i}_TEMP`]) !== 32768) {
      zone.temperatura = formatD10(props[`Z${i}_TEMP`]) + " °C";
    }
    if (props[`Z${i}_ZONE_SET`] !== undefined) {
      zone.setpoint = formatD10(props[`Z${i}_ZONE_SET`]) + " °C";
    }
    if (props[`Z${i}_RH`] !== undefined && Number(props[`Z${i}_RH`]) !== 32768) {
      zone.umidita = formatD10(props[`Z${i}_RH`]) + " %";
    }
    if (props[`Z${i}_SET_CW`] !== undefined) {
      zone.set_comfort_inv = formatD10(props[`Z${i}_SET_CW`]) + " °C";
    }
    if (props[`Z${i}_SET_CS`] !== undefined) {
      zone.set_comfort_est = formatD10(props[`Z${i}_SET_CS`]) + " °C";
    }

    result.zone.push(zone);
  }

  for (let i = 1; i <= 8; i++) {
    const xref = props[`C${i}_XREF`];
    if (xref === undefined || Number(xref) === 0) continue;

    const circ = {
      numero: i,
      temp_mandata: props[`C${i}_TEMP`] !== undefined ? formatD10(props[`C${i}_TEMP`]) + " °C" : "N/D",
      setpoint: props[`C${i}_SET`] !== undefined ? formatD10(props[`C${i}_SET`]) + " °C" : "N/D",
    };
    if (props[`C${i}_RET_TEMP`] !== undefined && Number(props[`C${i}_RET_TEMP`]) !== 32768) {
      circ.temp_ritorno = formatD10(props[`C${i}_RET_TEMP`]) + " °C";
    }
    result.circuiti.push(circ);
  }

  for (let a = 0; a <= 9; a++) {
    const key = `ALARM_${a}`;
    const val = Number(props[key] || 0);
    if (val === 0) continue;
    for (let b = 0; b < 8; b++) {
      if (val & (1 << b)) {
        result.allarmi_attivi.push(`${key} bit ${b}`);
      }
    }
  }

  result.timestamp = data.Timestamp || null;
  result.ultimo_aggiornamento = data.Latest || null;

  return { success: true, data: result };
}

// ============================================================
// TOOL: scrivi_proprieta
// ============================================================

async function scriviProprieta(propId, valore) {
  const url = `${ALTEREGO_BASE}/${STATION_ID}/putmprop?statid=${STATION_ID}&userid=guest&pcount=1&p0=${encodeURIComponent(propId)}&nb0=${encodeURIComponent(valore)}`;
  const resp = await authWrite(url);

  return {
    success: resp.status === 200,
    propId,
    valore,
    status: resp.status,
    response: resp.json || resp.body
  };
}

// ============================================================
// MCP PROTOCOL
// ============================================================

const TOOLS = [
  {
    name: "leggi_impianto",
    description: "Legge tutti i dati live dell'impianto Cappellotto AlterEgo di Via Borgazzi 12: stato impianto, stagione, ACS, temperature zone, setpoint, umidità, circuiti, allarmi.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "scrivi_proprieta",
    description: "Scrive una proprietà sull'impianto Cappellotto. Proprietà comuni: P_GLOBAL_ENABLE (0/1), P_GLOBAL_SEASON (0=inverno/1=estate), P_GLOBAL_ENABLE_ACS (0/1), Z{n}_FORCING (0=auto/1=off/3=comfort), Z{n}_SET_CW (setpoint comfort invernale D10), Z{n}_SET_CS (setpoint comfort estivo D10).",
    inputSchema: {
      type: "object",
      properties: {
        prop_id: { type: "string", description: "ID della proprietà da scrivere" },
        valore: { type: "number", description: "Valore numerico. Temperature: x10 (21.5°C=215). Booleani: 0/1." }
      },
      required: ["prop_id", "valore"]
    }
  }
];

async function handleMcpRequest(method, params) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "gaia-alteregoxl-mcp", version: WORKER_VERSION }
      };
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call":
      return await handleToolCall(params);
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    default:
      throw { code: -32601, message: `Method not found: ${method}` };
  }
}

async function handleToolCall(params) {
  const { name, arguments: args } = params;
  try {
    let result;
    switch (name) {
      case "leggi_impianto":
        result = await leggiImpianto();
        break;
      case "scrivi_proprieta":
        if (!args?.prop_id || args?.valore === undefined) throw new Error("Parametri obbligatori: prop_id, valore");
        result = await scriviProprieta(args.prop_id, args.valore);
        break;
      default:
        throw new Error(`Tool sconosciuto: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }], isError: true };
  }
}

// ============================================================
// ROUTES
// ============================================================

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
  res.header("Access-Control-Expose-Headers", "Mcp-Session-Id");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", version: WORKER_VERSION, station: STATION_ID, timestamp: new Date().toISOString() });
});

app.get("/debug-login", async (req, res) => {
  try {
    const r = await loginAlterEgo();
    res.json({ ok: r.ok, status: r.status, location: r.location, step3_status: r.step3_status, cookieLength: r.cookie ? r.cookie.length : 0, hasXsrf: !!r.xsrfDecoded, hasEmail: !!ALTEREGO_EMAIL, hasPassword: !!ALTEREGO_PASSWORD });
  } catch (err) { res.json({ error: err.message }); }
});

app.get("/debug-getres", async (req, res) => {
  try {
    const data = await authFetch(`${ALTEREGO_BASE}/${STATION_ID}/getres?timestamp=`);
    if (data.Data && Array.isArray(data.Data)) {
      res.json({ rowCount: data.Data.length, first5: data.Data.slice(0, 5), timestamp: data.Timestamp });
    } else {
      res.json({ raw: data });
    }
  } catch (err) { res.json({ error: err.message }); }
});

app.get("/sse", (req, res) => {
  const sessionId = require("crypto").randomUUID();
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers.host;
  const messageUrl = `${protocol}://${host}/message?sessionId=${sessionId}`;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
  res.write(`event: endpoint\ndata: ${messageUrl}\n\n`);
  const keepAlive = setInterval(() => { res.write(`: keepalive\n\n`); }, 15000);
  req.on("close", () => { clearInterval(keepAlive); });
});

async function handlePost(req, res) {
  try {
    const { method, params, id } = req.body;
    const result = await handleMcpRequest(method, params);
    if (result === null) return res.sendStatus(202);
    res.json({ jsonrpc: "2.0", id, result });
  } catch (err) {
    res.json({ jsonrpc: "2.0", id: null, error: { code: err.code || -32603, message: err.message } });
  }
}

app.post("/message", handlePost);
app.post("/mcp", handlePost);
app.post("/", handlePost);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`GAIA AlterEgoXL MCP v${WORKER_VERSION} on port ${PORT}`); });
