// GAIA ALTEREGOXL MCP Server v1.5.0
// Node.js per Render.com
//
// CHANGELOG v1.5.0:
// AE-06 — set_impianto: accende/spegne l'intero impianto
// AE-07 — set_stagione: cambia stagione inverno/estate
// AE-08 — set_appartamento: forzatura su tutte le zone di un appartamento (login singolo)
// AE-09 — set_tutto_off: spegne tutte le zone (login singolo)
// AE-10 — set_tutto_auto: riporta tutte le zone in automatico (login singolo)
// AE-11 — leggi_appartamento: snapshot di un singolo appartamento
// AE-12 — leggi_allarmi: solo sezione allarmi
// AE-13 — check_anomalie: diagnostica automatica su dati live
//
// CHANGELOG v1.4.0:
// AE-04 — set_setpoint_zona
// AE-05 — set_forzatura_zona
//
// CHANGELOG v1.3.0:
// AE-01 — mapping zone + raggruppamento appartamenti
// AE-02 — fix prop_id descrizione scrivi_proprieta
// AE-03 — fix path debug-getres

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const express = require("express");
const https = require("https");
const http = require("http");
const { URL } = require("url");

const app = express();
app.use(express.json());

const WORKER_VERSION = "1.5.0";
const STATION_ID = "DOT_OHIILHBG";
const ALTEREGO_BASE = "https://areariservata.alteregoxl.it";
const ALTEREGO_EMAIL = process.env.ALTEREGO_EMAIL || "";
const ALTEREGO_PASSWORD = process.env.ALTEREGO_PASSWORD || "";

// ============================================================
// ZONE MAPPING
// ============================================================

const ZONE_MAP = {
  1:  { nome: "Taverna",     appartamento: "Interrato" },
  2:  { nome: "Soggiorno",   appartamento: "App. Piano Terra Sx" },
  3:  { nome: "Camera",      appartamento: "App. Piano Terra Sx" },
  4:  { nome: "Bagno",       appartamento: "App. Piano Terra Sx" },
  5:  { nome: "Soggiorno",   appartamento: "App. Piano Terra Dx" },
  6:  { nome: "Studio",      appartamento: "App. Piano Terra Dx" },
  7:  { nome: "Camera",      appartamento: "App. Piano Terra Dx" },
  8:  { nome: "Bagno",       appartamento: "App. Piano Terra Dx" },
  9:  { nome: "Soggiorno",   appartamento: "Piano Primo" },
  10: { nome: "Corridoio",   appartamento: "Piano Primo" },
  12: { nome: "Camera",      appartamento: "Piano Primo" },
  13: { nome: "Bagno",       appartamento: "Piano Primo" },
  14: { nome: "Corridoio 2", appartamento: "Piano Primo" },
  16: { nome: "Soggiorno",   appartamento: "Mansarda" },
  17: { nome: "Camera",      appartamento: "Mansarda" },
  18: { nome: "Bagno",       appartamento: "Mansarda" },
};

const APPARTAMENTO_ORDER = [
  "Interrato",
  "App. Piano Terra Sx",
  "App. Piano Terra Dx",
  "Piano Primo",
  "Mansarda"
];

const FORZATURA_MAP = { auto: 0, off: 1, economy: 2, comfort: 3 };

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
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
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
  for (const [k, v] of Object.entries(newCookies)) map[k] = v;
  return Object.entries(map).map(([k, v]) => `${k}=${v}`).join("; ");
}

function getXsrfFromCookieStr(cookieStr) {
  const match = cookieStr.match(/XSRF-TOKEN=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

// ============================================================
// LOGIN (3 steps)
// ============================================================

async function loginAlterEgo() {
  const step1 = await rawFetch(`${ALTEREGO_BASE}/login`, {
    headers: { "User-Agent": "GAIA-AlterEgoXL/1.5" }
  });

  const cookies1 = extractCookies(step1.headers);
  const xsrfToken = cookies1["XSRF-TOKEN"] || "";
  const laravelSession = cookies1["laravel_session"] || "";

  if (!xsrfToken) {
    return { cookie: "", ok: false, error: "No XSRF-TOKEN", step1_status: step1.status };
  }

  const csrfToken = decodeURIComponent(xsrfToken);
  let cookieStr = `XSRF-TOKEN=${xsrfToken}; laravel_session=${laravelSession}`;

  const step2 = await rawFetch(`${ALTEREGO_BASE}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": cookieStr,
      "User-Agent": "GAIA-AlterEgoXL/1.5"
    },
    body: `_token=${encodeURIComponent(csrfToken)}&email=${encodeURIComponent(ALTEREGO_EMAIL)}&password=${encodeURIComponent(ALTEREGO_PASSWORD)}`
  });

  if (step2.status !== 302) {
    return { cookie: "", ok: false, error: "Login POST non 302", status: step2.status };
  }

  const cookies2 = extractCookies(step2.headers);
  cookieStr = mergeCookieString(cookieStr, cookies2);

  const location = step2.headers["location"] || `${ALTEREGO_BASE}/home`;
  const step3 = await rawFetch(location, {
    headers: {
      "Cookie": cookieStr,
      "User-Agent": "GAIA-AlterEgoXL/1.5",
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
    location,
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
      "User-Agent": "GAIA-AlterEgoXL/1.5",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": login.xsrfDecoded
    }
  });

  try { return JSON.parse(resp.body); }
  catch { return { raw: resp.body.substring(0, 500), status: resp.status }; }
}

// ============================================================
// AUTHENTICATED WRITE — singola proprietà
// ============================================================

async function authWrite(url) {
  const login = await loginAlterEgo();
  if (!login.ok) return { success: false, error: `Login fallito: ${login.error}` };
  return authWriteWithSession(url, login);
}

// Write con sessione già aperta (per operazioni multi-zona)
async function authWriteWithSession(url, login) {
  const resp = await rawFetch(url, {
    headers: {
      "Cookie": login.cookie,
      "User-Agent": "GAIA-AlterEgoXL/1.5",
      "Accept": "application/json, text/javascript, */*; q=0.01",
      "X-Requested-With": "XMLHttpRequest",
      "X-XSRF-TOKEN": login.xsrfDecoded
    }
  });

  let json;
  try { json = JSON.parse(resp.body); } catch { json = null; }
  return { status: resp.status, json, body: resp.body.substring(0, 300) };
}

// Write multiplo — login singolo, N scritture sequenziali
async function authWriteMulti(propValuePairs) {
  const login = await loginAlterEgo();
  if (!login.ok) return { ok: false, error: `Login fallito: ${login.error}`, results: [] };

  const results = [];
  for (const { propId, valore } of propValuePairs) {
    const url = buildWriteUrl(propId, valore);
    const resp = await authWriteWithSession(url, login);
    results.push({
      propId,
      valore,
      success: resp.status === 200,
      status: resp.status,
      response: resp.json || resp.body
    });
  }
  return { ok: true, results };
}

function buildWriteUrl(propId, valore) {
  return `${ALTEREGO_BASE}/station/${STATION_ID}/putmprop?statid=${STATION_ID}&userid=guest&pcount=1&p0=${encodeURIComponent(propId)}&nb0=${encodeURIComponent(valore)}`;
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

function formatD10Raw(bv) {
  const v = Number(bv);
  if (v === 32768 || v === 32769 || v < 0) return null;
  let val = v;
  if (val >= 32768) val -= 65536;
  return val / 10;
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
// CORE: leggi dati grezzi impianto
// ============================================================

async function fetchImpianto() {
  const data = await authFetch(`${ALTEREGO_BASE}/station/${STATION_ID}/getres?timestamp=`);
  if (!data.Data) throw new Error("Nessun dato ricevuto dall'impianto");

  const props = {};
  for (const item of data.Data) props[item.Id] = item.V;

  return { props, timestamp: data.Timestamp, latest: data.Latest };
}

function buildZoneFlat(props) {
  const zoneFlat = [];
  for (let i = 1; i <= 24; i++) {
    const xref = props[`Z${i}_ZONE_XREF`];
    if (xref === undefined || Number(xref) === 0) continue;

    const mapping = ZONE_MAP[i] || { nome: `Zona ${i}`, appartamento: "Sconosciuto" };
    const zone = {
      numero: i,
      nome: mapping.nome,
      appartamento: mapping.appartamento,
      modo: props[`Z${i}_ZONE_MODE`] !== undefined ? formatZoneMode(props[`Z${i}_ZONE_MODE`]) : "N/D",
      uscita: props[`Z${i}_OUTPUT`] !== undefined ? formatBool(props[`Z${i}_OUTPUT`]) : "N/D",
      forzatura: props[`Z${i}_FORCING`] !== undefined ? formatForcing(props[`Z${i}_FORCING`]) : "N/D",
    };

    if (props[`Z${i}_TEMP`] !== undefined && Number(props[`Z${i}_TEMP`]) !== 32768)
      zone.temperatura = formatD10(props[`Z${i}_TEMP`]) + " °C";
    if (props[`Z${i}_ZONE_SET`] !== undefined)
      zone.setpoint = formatD10(props[`Z${i}_ZONE_SET`]) + " °C";
    if (props[`Z${i}_RH`] !== undefined && Number(props[`Z${i}_RH`]) !== 32768)
      zone.umidita = formatD10(props[`Z${i}_RH`]) + " %";
    if (props[`Z${i}_SET_CW`] !== undefined)
      zone.set_comfort_inv = formatD10(props[`Z${i}_SET_CW`]) + " °C";
    if (props[`Z${i}_SET_CS`] !== undefined)
      zone.set_comfort_est = formatD10(props[`Z${i}_SET_CS`]) + " °C";

    zoneFlat.push(zone);
  }
  return zoneFlat;
}

function buildAppartamenti(zoneFlat) {
  const appartamenti = {};
  for (const apt of APPARTAMENTO_ORDER) {
    const zoneApt = zoneFlat.filter(z => z.appartamento === apt);
    if (zoneApt.length === 0) continue;
    appartamenti[apt] = { zone: zoneApt.map(({ appartamento, ...rest }) => rest) };
  }
  for (const z of zoneFlat) {
    if (!appartamenti[z.appartamento]) {
      appartamenti[z.appartamento] = { zone: [] };
      appartamenti[z.appartamento].zone.push((({ appartamento, ...rest }) => rest)(z));
    }
  }
  return appartamenti;
}

function buildCircuiti(props) {
  const circuiti = [];
  for (let i = 1; i <= 8; i++) {
    const xref = props[`C${i}_XREF`];
    if (xref === undefined || Number(xref) === 0) continue;
    const circ = {
      numero: i,
      temp_mandata: props[`C${i}_TEMP`] !== undefined ? formatD10(props[`C${i}_TEMP`]) + " °C" : "N/D",
      setpoint: props[`C${i}_SET`] !== undefined ? formatD10(props[`C${i}_SET`]) + " °C" : "N/D",
    };
    if (props[`C${i}_RET_TEMP`] !== undefined && Number(props[`C${i}_RET_TEMP`]) !== 32768)
      circ.temp_ritorno = formatD10(props[`C${i}_RET_TEMP`]) + " °C";
    circuiti.push(circ);
  }
  return circuiti;
}

function buildAllarmi(props) {
  const allarmi = [];
  for (let a = 0; a <= 9; a++) {
    const key = `ALARM_${a}`;
    const val = Number(props[key] || 0);
    if (val === 0) continue;
    for (let b = 0; b < 8; b++) {
      if (val & (1 << b)) allarmi.push(`${key} bit ${b}`);
    }
  }
  return allarmi;
}

function buildImpiantoHeader(props) {
  return {
    stato: props.GLOBAL_ENABLE !== undefined ? formatBool(props.GLOBAL_ENABLE) : "N/D",
    stagione: props.GLOBAL_SEASON !== undefined ? formatSeason(props.GLOBAL_SEASON) : "N/D",
    acs_stato: props.GLOBAL_ACS_ENABLE !== undefined ? formatBool(props.GLOBAL_ACS_ENABLE) : "N/D",
    temp_esterna: props.GLOBAL_T_EXT !== undefined ? formatD10(props.GLOBAL_T_EXT) + " °C" : "N/D",
    temp_acs: props.GLOBAL_T_ACS !== undefined ? formatD10(props.GLOBAL_T_ACS) + " °C" : "N/D",
  };
}

// ============================================================
// TOOL: leggi_impianto
// ============================================================

async function leggiImpianto() {
  try {
    const { props, timestamp, latest } = await fetchImpianto();
    const zoneFlat = buildZoneFlat(props);
    return {
      success: true,
      data: {
        impianto: buildImpiantoHeader(props),
        appartamenti: buildAppartamenti(zoneFlat),
        circuiti: buildCircuiti(props),
        allarmi_attivi: buildAllarmi(props),
        timestamp: timestamp || null,
        ultimo_aggiornamento: latest || null,
      }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// TOOL: leggi_appartamento — AE-11
// ============================================================

async function leggiAppartamento(appartamento) {
  const aptNorm = APPARTAMENTO_ORDER.find(
    a => a.toLowerCase() === appartamento.toLowerCase()
  );
  if (!aptNorm) {
    return {
      success: false,
      error: `Appartamento non trovato: "${appartamento}".`,
      appartamenti_validi: APPARTAMENTO_ORDER
    };
  }

  try {
    const { props, timestamp, latest } = await fetchImpianto();
    const zoneFlat = buildZoneFlat(props).filter(z => z.appartamento === aptNorm);

    return {
      success: true,
      appartamento: aptNorm,
      zone: zoneFlat.map(({ appartamento: _, ...rest }) => rest),
      timestamp: timestamp || null,
      ultimo_aggiornamento: latest || null,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// TOOL: leggi_allarmi — AE-12
// ============================================================

async function leggiAllarmi() {
  try {
    const { props, timestamp, latest } = await fetchImpianto();
    const allarmi = buildAllarmi(props);
    return {
      success: true,
      allarmi_attivi: allarmi,
      count: allarmi.length,
      stato_impianto: props.GLOBAL_ENABLE !== undefined ? formatBool(props.GLOBAL_ENABLE) : "N/D",
      timestamp: timestamp || null,
      ultimo_aggiornamento: latest || null,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// TOOL: check_anomalie — AE-13
// ============================================================

async function checkAnomalie() {
  try {
    const { props, timestamp, latest } = await fetchImpianto();
    const zoneFlat = buildZoneFlat(props);
    const anomalie = [];

    // Allarmi attivi
    const allarmi = buildAllarmi(props);
    for (const a of allarmi) {
      anomalie.push({ tipo: "ALLARME", zona: null, appartamento: null, dettaglio: a });
    }

    // Analisi per zona
    for (const z of zoneFlat) {
      const zonaLabel = `${z.nome} (${z.appartamento})`;

      // Umidità alta — rischio muffa
      const rh = props[`Z${z.numero}_RH`];
      if (rh !== undefined) {
        const rhVal = formatD10Raw(rh);
        if (rhVal !== null && rhVal >= 70) {
          anomalie.push({
            tipo: "UMIDITÀ_ALTA",
            zona: z.numero,
            appartamento: z.appartamento,
            dettaglio: `${zonaLabel}: umidità ${rhVal.toFixed(1)}% — rischio muffa`
          });
        }
      }

      // Temperatura bassa — rischio gelo
      const temp = props[`Z${z.numero}_TEMP`];
      if (temp !== undefined) {
        const tempVal = formatD10Raw(temp);
        if (tempVal !== null && tempVal < 8) {
          anomalie.push({
            tipo: "RISCHIO_GELO",
            zona: z.numero,
            appartamento: z.appartamento,
            dettaglio: `${zonaLabel}: temperatura ${tempVal.toFixed(1)}°C — rischio gelo`
          });
        }
      }

      // Sensore temperatura N/C su zona non spenta
      const forcing = Number(props[`Z${z.numero}_FORCING`] || 0);
      const tempRaw = Number(props[`Z${z.numero}_TEMP`]);
      const sensoreMancante = tempRaw === 32769; // N/C
      if (sensoreMancante && forcing !== 1) {
        anomalie.push({
          tipo: "SENSORE_DISCONNESSO",
          zona: z.numero,
          appartamento: z.appartamento,
          dettaglio: `${zonaLabel}: sensore temperatura N/C su zona attiva (forzatura: ${formatForcing(forcing)})`
        });
      }
    }

    // Delta temperatura tra zone dello stesso appartamento
    for (const apt of APPARTAMENTO_ORDER) {
      const zoneApt = zoneFlat.filter(z => z.appartamento === apt);
      const tempsValide = zoneApt
        .map(z => ({ nome: z.nome, val: formatD10Raw(props[`Z${z.numero}_TEMP`]) }))
        .filter(t => t.val !== null);

      if (tempsValide.length >= 2) {
        const max = Math.max(...tempsValide.map(t => t.val));
        const min = Math.min(...tempsValide.map(t => t.val));
        if (max - min > 5) {
          const nomeMax = tempsValide.find(t => t.val === max).nome;
          const nomeMin = tempsValide.find(t => t.val === min).nome;
          anomalie.push({
            tipo: "DELTA_TEMPERATURA",
            zona: null,
            appartamento: apt,
            dettaglio: `${apt}: delta ${(max - min).toFixed(1)}°C tra ${nomeMax} (${max.toFixed(1)}°C) e ${nomeMin} (${min.toFixed(1)}°C)`
          });
        }
      }
    }

    return {
      success: true,
      anomalie_rilevate: anomalie.length,
      anomalie,
      stato_impianto: props.GLOBAL_ENABLE !== undefined ? formatBool(props.GLOBAL_ENABLE) : "N/D",
      stagione: props.GLOBAL_SEASON !== undefined ? formatSeason(props.GLOBAL_SEASON) : "N/D",
      timestamp: timestamp || null,
      ultimo_aggiornamento: latest || null,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// TOOL: scrivi_proprieta (generico — emergenza)
// ============================================================

async function scriviProprieta(propId, valore) {
  const url = buildWriteUrl(propId, valore);
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
// TOOL: set_setpoint_zona — AE-04
// ============================================================

async function setSetpointZona(zona, temperatura, stagione) {
  const zonaNum = Number(zona);
  const mapping = ZONE_MAP[zonaNum];
  if (!mapping) return { success: false, error: `Zona ${zonaNum} non presente nel mapping.` };
  if (isNaN(temperatura) || temperatura < 5 || temperatura > 35)
    return { success: false, error: `Temperatura non valida: ${temperatura}. Range consentito: 5–35 °C.` };

  const stagNorm = (stagione || "inverno").toLowerCase();
  if (stagNorm !== "inverno" && stagNorm !== "estate")
    return { success: false, error: `Stagione non valida: "${stagione}". Usare "inverno" o "estate".` };

  const propId = stagNorm === "inverno" ? `Z${zonaNum}_SET_CW` : `Z${zonaNum}_SET_CS`;
  const valoreD10 = Math.round(temperatura * 10);
  const resp = await scriviProprieta(propId, valoreD10);

  return {
    success: resp.success,
    zona: zonaNum,
    nome: mapping.nome,
    appartamento: mapping.appartamento,
    stagione: stagNorm,
    temperatura_impostata: `${temperatura} °C`,
    prop_id: propId,
    valore_d10: valoreD10,
    status: resp.status,
    response: resp.response
  };
}

// ============================================================
// TOOL: set_forzatura_zona — AE-05
// ============================================================

async function setForzaturaZona(zona, modo) {
  const zonaNum = Number(zona);
  const mapping = ZONE_MAP[zonaNum];
  if (!mapping) return { success: false, error: `Zona ${zonaNum} non presente nel mapping.` };

  const modoNorm = (modo || "").toLowerCase();
  if (!(modoNorm in FORZATURA_MAP))
    return { success: false, error: `Modo non valido: "${modo}". Valori ammessi: auto, off, economy, comfort.` };

  const propId = `Z${zonaNum}_FORCING`;
  const valore = FORZATURA_MAP[modoNorm];
  const resp = await scriviProprieta(propId, valore);

  return {
    success: resp.success,
    zona: zonaNum,
    nome: mapping.nome,
    appartamento: mapping.appartamento,
    modo_impostato: modoNorm,
    prop_id: propId,
    valore,
    status: resp.status,
    response: resp.response
  };
}

// ============================================================
// TOOL: set_impianto — AE-06
// ============================================================

async function setImpianto(stato) {
  const statoNorm = (stato || "").toLowerCase();
  if (statoNorm !== "on" && statoNorm !== "off")
    return { success: false, error: `Stato non valido: "${stato}". Usare "on" o "off".` };

  const valore = statoNorm === "on" ? 1 : 0;
  const resp = await scriviProprieta("GLOBAL_ENABLE", valore);

  return {
    success: resp.success,
    stato_impostato: statoNorm.toUpperCase(),
    prop_id: "GLOBAL_ENABLE",
    valore,
    status: resp.status,
    response: resp.response
  };
}

// ============================================================
// TOOL: set_stagione — AE-07
// ============================================================

async function setStagione(stagione) {
  const stagNorm = (stagione || "").toLowerCase();
  if (stagNorm !== "inverno" && stagNorm !== "estate")
    return { success: false, error: `Stagione non valida: "${stagione}". Usare "inverno" o "estate".` };

  const valore = stagNorm === "inverno" ? 0 : 1;
  const resp = await scriviProprieta("GLOBAL_SEASON", valore);

  return {
    success: resp.success,
    stagione_impostata: stagNorm,
    prop_id: "GLOBAL_SEASON",
    valore,
    status: resp.status,
    response: resp.response
  };
}

// ============================================================
// TOOL: set_appartamento — AE-08
// ============================================================

async function setAppartamento(appartamento, modo) {
  const aptNorm = APPARTAMENTO_ORDER.find(
    a => a.toLowerCase() === appartamento.toLowerCase()
  );
  if (!aptNorm) {
    return {
      success: false,
      error: `Appartamento non trovato: "${appartamento}".`,
      appartamenti_validi: APPARTAMENTO_ORDER
    };
  }

  const modoNorm = (modo || "").toLowerCase();
  if (!(modoNorm in FORZATURA_MAP))
    return { success: false, error: `Modo non valido: "${modo}". Valori ammessi: auto, off, economy, comfort.` };

  const zoneApt = Object.entries(ZONE_MAP)
    .filter(([, v]) => v.appartamento === aptNorm)
    .map(([k, v]) => ({ numero: Number(k), nome: v.nome }));

  const pairs = zoneApt.map(z => ({ propId: `Z${z.numero}_FORCING`, valore: FORZATURA_MAP[modoNorm] }));
  const { ok, error, results } = await authWriteMulti(pairs);

  if (!ok) return { success: false, error };

  return {
    success: results.every(r => r.success),
    appartamento: aptNorm,
    modo_impostato: modoNorm,
    zone_aggiornate: zoneApt.map((z, i) => ({
      numero: z.numero,
      nome: z.nome,
      success: results[i].success,
      status: results[i].status
    }))
  };
}

// ============================================================
// TOOL: set_tutto_off — AE-09
// ============================================================

async function setTuttoOff() {
  const pairs = Object.entries(ZONE_MAP).map(([k]) => ({
    propId: `Z${k}_FORCING`,
    valore: FORZATURA_MAP.off
  }));

  const { ok, error, results } = await authWriteMulti(pairs);
  if (!ok) return { success: false, error };

  const zone = Object.entries(ZONE_MAP).map(([k, v], i) => ({
    numero: Number(k),
    nome: v.nome,
    appartamento: v.appartamento,
    success: results[i].success
  }));

  return {
    success: results.every(r => r.success),
    operazione: "set_tutto_off",
    zone_aggiornate: zone.length,
    zone,
    fallite: zone.filter(z => !z.success)
  };
}

// ============================================================
// TOOL: set_tutto_auto — AE-10
// ============================================================

async function setTuttoAuto() {
  const pairs = Object.entries(ZONE_MAP).map(([k]) => ({
    propId: `Z${k}_FORCING`,
    valore: FORZATURA_MAP.auto
  }));

  const { ok, error, results } = await authWriteMulti(pairs);
  if (!ok) return { success: false, error };

  const zone = Object.entries(ZONE_MAP).map(([k, v], i) => ({
    numero: Number(k),
    nome: v.nome,
    appartamento: v.appartamento,
    success: results[i].success
  }));

  return {
    success: results.every(r => r.success),
    operazione: "set_tutto_auto",
    zone_aggiornate: zone.length,
    zone,
    fallite: zone.filter(z => !z.success)
  };
}

// ============================================================
// MCP PROTOCOL
// ============================================================

const TOOLS = [
  {
    name: "leggi_impianto",
    description: "Legge tutti i dati live dell'impianto Cappellotto AlterEgo di Via Borgazzi 12: stato impianto, stagione, temperature zone raggruppate per appartamento, setpoint, umidità, circuiti, allarmi.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "leggi_appartamento",
    description: "Legge i dati live di un singolo appartamento. Appartamenti validi: Interrato, App. Piano Terra Sx, App. Piano Terra Dx, Piano Primo, Mansarda.",
    inputSchema: {
      type: "object",
      properties: {
        appartamento: { type: "string", description: "Nome appartamento (es. 'Piano Primo')" }
      },
      required: ["appartamento"]
    }
  },
  {
    name: "leggi_allarmi",
    description: "Legge solo gli allarmi attivi dell'impianto. Risposta leggera per check rapido.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "check_anomalie",
    description: "Diagnostica automatica sull'impianto: rileva allarmi attivi, umidità alta (rischio muffa ≥70%), rischio gelo (<8°C), sensori disconnessi su zone attive, delta temperatura anomalo tra zone dello stesso appartamento (>5°C).",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "set_impianto",
    description: "Accende o spegne l'intero impianto Cappellotto (GLOBAL_ENABLE).",
    inputSchema: {
      type: "object",
      properties: {
        stato: { type: "string", description: "'on' per accendere, 'off' per spegnere" }
      },
      required: ["stato"]
    }
  },
  {
    name: "set_stagione",
    description: "Cambia la stagione dell'impianto tra inverno ed estate (GLOBAL_SEASON). Operazione critica — confermare sempre con l'utente prima di eseguire.",
    inputSchema: {
      type: "object",
      properties: {
        stagione: { type: "string", description: "'inverno' o 'estate'" }
      },
      required: ["stagione"]
    }
  },
  {
    name: "set_setpoint_zona",
    description: "Imposta la temperatura di comfort di una singola zona. Numero zona ricavabile da leggi_impianto. Range: 5–35°C. Stagione default: inverno.",
    inputSchema: {
      type: "object",
      properties: {
        zona:        { type: "number", description: "Numero zona (es. 12 per Camera Piano Primo)" },
        temperatura: { type: "number", description: "Temperatura in °C (es. 21.5). Range: 5–35." },
        stagione:    { type: "string", description: "'inverno' (default) o 'estate'" }
      },
      required: ["zona", "temperatura"]
    }
  },
  {
    name: "set_forzatura_zona",
    description: "Imposta la modalità di forzatura di una singola zona: auto (segue programma), off (zona spenta), comfort, economy.",
    inputSchema: {
      type: "object",
      properties: {
        zona: { type: "number", description: "Numero zona (es. 12 per Camera Piano Primo)" },
        modo: { type: "string", description: "'auto', 'off', 'comfort', 'economy'" }
      },
      required: ["zona", "modo"]
    }
  },
  {
    name: "set_appartamento",
    description: "Imposta la stessa forzatura su tutte le zone di un appartamento in una sola operazione. Appartamenti: Interrato, App. Piano Terra Sx, App. Piano Terra Dx, Piano Primo, Mansarda.",
    inputSchema: {
      type: "object",
      properties: {
        appartamento: { type: "string", description: "Nome appartamento (es. 'Piano Primo')" },
        modo: { type: "string", description: "'auto', 'off', 'comfort', 'economy'" }
      },
      required: ["appartamento", "modo"]
    }
  },
  {
    name: "set_tutto_off",
    description: "Spegne tutte le zone dell'impianto in una sola operazione (forzatura off su tutti gli appartamenti). Utile prima di assenze prolungate.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "set_tutto_auto",
    description: "Riporta tutte le zone dell'impianto in modalità automatica in una sola operazione. Speculare a set_tutto_off.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "scrivi_proprieta",
    description: "Tool generico — usa solo per proprietà non coperte dai tool semantici. Proprietà comuni: GLOBAL_ENABLE (0/1), GLOBAL_SEASON (0=inverno/1=estate), Z{n}_FORCING (0=auto/1=off/2=economy/3=comfort), Z{n}_SET_CW (setpoint comfort invernale D10), Z{n}_SET_CS (setpoint comfort estivo D10).",
    inputSchema: {
      type: "object",
      properties: {
        prop_id: { type: "string", description: "ID della proprietà da scrivere" },
        valore:  { type: "number", description: "Valore numerico. Temperature: x10 (21.5°C=215). Booleani: 0/1." }
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
        result = await leggiImpianto(); break;
      case "leggi_appartamento":
        if (!args?.appartamento) throw new Error("Parametro obbligatorio: appartamento");
        result = await leggiAppartamento(args.appartamento); break;
      case "leggi_allarmi":
        result = await leggiAllarmi(); break;
      case "check_anomalie":
        result = await checkAnomalie(); break;
      case "set_impianto":
        if (!args?.stato) throw new Error("Parametro obbligatorio: stato");
        result = await setImpianto(args.stato); break;
      case "set_stagione":
        if (!args?.stagione) throw new Error("Parametro obbligatorio: stagione");
        result = await setStagione(args.stagione); break;
      case "set_setpoint_zona":
        if (args?.zona === undefined || args?.temperatura === undefined)
          throw new Error("Parametri obbligatori: zona, temperatura");
        result = await setSetpointZona(args.zona, args.temperatura, args.stagione); break;
      case "set_forzatura_zona":
        if (args?.zona === undefined || !args?.modo)
          throw new Error("Parametri obbligatori: zona, modo");
        result = await setForzaturaZona(args.zona, args.modo); break;
      case "set_appartamento":
        if (!args?.appartamento || !args?.modo)
          throw new Error("Parametri obbligatori: appartamento, modo");
        result = await setAppartamento(args.appartamento, args.modo); break;
      case "set_tutto_off":
        result = await setTuttoOff(); break;
      case "set_tutto_auto":
        result = await setTuttoAuto(); break;
      case "scrivi_proprieta":
        if (!args?.prop_id || args?.valore === undefined)
          throw new Error("Parametri obbligatori: prop_id, valore");
        result = await scriviProprieta(args.prop_id, args.valore); break;
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
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version");
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
    const data = await authFetch(`${ALTEREGO_BASE}/station/${STATION_ID}/getres?timestamp=`);
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
