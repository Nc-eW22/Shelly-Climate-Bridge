// ⚡ SPARK_LABS: Climate Bridge — Brain v1.0
// Ref: ClimateBridge_FW_Spec_v1.0 | KVS: BM01 v1.1 split schema
//
// WHAT THIS SCRIPT DOES
//   Provides bidirectional sync between Shelly virtual components and
//   a Home Assistant climate entity. Shelly app is the UI — HA is infrastructure.
//   No cloud. No proprietary app. All local.
//
// SYNC MODEL
//   Outbound: user changes a VC → Brain debounces → HTTP POST to HA climate service
//   Inbound:  HA pushes state to /script/{id}/sync → Brain updates all VCs
//   Echo prevention: LAST_VC dedup + sync lock suppress feedback loops
//
// BOOT SEQUENCE
//   loadKVS → probeFeatures → registerEndpoint → registerStatusHandler
//   → readBTHome → restoreCachedState → syncFromHA → done

// ── OVERRIDE (testing only — must be false in production) ─────────
const OVERRIDE = false;

// ── SYSTEM CONSTANTS ─────────────────────────────────────────────
// SYNC_LOCK_MS: window after inbound write during which outbound is suppressed
// DEBOUNCE_MS:  accumulates rapid VC changes before sending to HA
// HEALTH_WARN/DOWN: ha_fail_count thresholds for ⚠️ and ❌ status glyphs
const VERSION      = '1.0';
const SYNC_LOCK_MS = 1500;
const DEBOUNCE_MS  = 800;
const HEALTH_WARN  = 1;
const HEALTH_DOWN  = 3;
const QUEUE_MAX    = 20;

// ── STATUS TEXT GLYPH TABLES ──────────────────────────────────────
// mJS does not support \uXXXX escape sequences — all emoji are raw UTF-8.
// MG = mode glyphs (keyed by HA hvac_mode string)
// FG = fan glyphs  (keyed by HA fan_mode string)
// SG = swing glyphs (keyed by HA swing_mode string)
// Glyph tables — raw UTF-8 chars only (no \uXXXX — banned in mJS)
let MG = {};
MG['cool']     = '❄️'; MG['heat'] = '🔥'; MG['fan_only'] = '💨';
MG['dry']      = '💧'; MG['auto'] = '🔁';

let FG = {};
FG['low'] = '֎L'; FG['medium'] = '֎M'; FG['high'] = '֎H'; FG['auto'] = '֎A';

let SG = {};
SG['vertical'] = '↕️'; SG['horizontal'] = '↔️'; SG['both'] = '🔀';

// ── RUNTIME STATE ─────────────────────────────────────────────────
// Declared before queue objects so all closures can reference them.
// CONFIG: loaded from KVS on boot — never hardcoded site values in Brain
// MAPS: bidirectional HA<->Shelly value lookup tables (loaded from KVS)
// CACHE: last known AC state — used for status text + power restore
// LAST_VC: last value written to each VC — prevents outbound echo loops
// Runtime state — declared before queues so closures can reference
let CONFIG = {
    token: null, url: null, entity: null,
    debug: false, print_yaml: false, has_bthome: false,
    vc: { temp:200, mode:200, fan:201, swing:202, power:200,
          room_temp:201, room_hum:202, status:200, group:200 }
};
let MAPS  = { toShelly:{ mode:null, fan:null, swing:null },
              toHA:    { mode:null, fan:null, swing:null } };
let CACHE = { temp:null, hvac:null, fan:null, swing:null,
              current_temp:null, humidity:null, last_mode:null };
let HAS_SWING = false, HAS_ROOM_VC = false, HAS_POWER = false;
let sync_lock = false, SELF_ID = null;
let TIMERS  = { sync_lock:null, debounce:null };
let LAST_UI = { status:'' };
// Tracks last value written to each VC — dedup prevents echo loops
let LAST_VC = { temp:null, mode:null, fan:null, swing:null, power:null };
let hfc   = 0;    // ha_fail_count
let room_t = null; // BTHome temp (bthomesensor:201)
let room_h = null; // BTHome humidity (bthomesensor:200)

function debugLog(msg) { if (CONFIG.debug) console.log(msg); }

// ── SAFE HELPERS (B01) ───────────────────────────────────────────
// Safe helpers
function safeParse(raw, lbl) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch(e) {
        console.log('[CB] JSON err: ' + lbl); return null;
    }
}
function saveJSON(key, obj) { Script.storage.setItem(key, JSON.stringify(obj)); }

// ── UI DEDUPLICATION + STATUS TEXT (B07/B08) ─────────────────────
// updateStatus: only calls Text.Set when string has changed (saves RPC calls)
// buildRoomSeg: formats BTHome sensor data for status bar
// buildStatusText: assembles full status string from CACHE + feature flags
//   Off state:  🏠19° 75%|📶
//   Active:     ❄️24°|֎H|↔️|🏠19° 75%|📶
// UI deduplication
function updateStatus(str) {
    if (!str || str === LAST_UI.status) return;
    VC_Queue.add('Text', CONFIG.vc.status, str);
    LAST_UI.status = str;
}

// Status text builder
function getHealthGlyph() {
    if (hfc >= HEALTH_DOWN) return '❌';
    if (hfc >= HEALTH_WARN) return '⚠️';
    return '📶';
}
function buildRoomSeg() {
    // 🏠 19°74% — omit if no BTHome data yet
    if (room_t === null && room_h === null) return null;
    let s = '🏠';
    if (room_t !== null) s = s + String(Math.round(room_t)) + '°';
    if (room_h !== null) s = s + ' ' + String(Math.round(room_h)) + '%';
    return s;
}

function buildStatusText() {
    let parts = [];
    let isOff = (!CACHE.hvac || CACHE.hvac === 'off');
    let SEP = '|'; // no spaces — tight format to fit 50 char limit

    if (isOff) {
        // Off: room data + health only
        let rs = buildRoomSeg();
        if (rs) parts.push(rs);
        parts.push(getHealthGlyph());
        return parts.join(SEP);
    }

    // Mode + set temp: ❄️24°
    let ts = (CACHE.temp !== null) ? (String(CACHE.temp) + '°') : '--';
    parts.push((MG[CACHE.hvac] || '?') + ts);

    // Fan: single letter H/M/L/A
    if (CACHE.fan) {
        let fl = FG[CACHE.fan];
        if (fl) parts.push(fl);
    }

    // Swing: directional glyph per value
    if (HAS_SWING && CACHE.swing && CACHE.swing !== 'off') {
        let sg = SG[CACHE.swing]; if (sg) parts.push(sg);
    }

    // Room data
    let rs = buildRoomSeg();
    if (rs) parts.push(rs);

    parts.push(getHealthGlyph());
    return parts.join(SEP);
}

// ── VC_QUEUE — INBOUND WRITE QUEUE (B02) ────────────────────────
// Serialises all Shelly.call(*.Set) operations to prevent concurrent RPC.
// mJS has no Array.shift() — uses index 0 + while-loop rebuild pattern.
// Refreshes sync_lock timer on each write completion so the lock window
// extends to cover all serial writes, not just the first.
// VC_Queue — serial virtual component write queue
// Note: mJS has no Array.shift() — use index 0 + while-loop rebuild
let VC_Queue = {
    _i: [], _b: false,
    add: function(type, id, val) {
        if (VC_Queue._i.length >= QUEUE_MAX) {
            let tmp = []; let j = 1;
            while (j < VC_Queue._i.length) { tmp.push(VC_Queue._i[j]); j++; }
            VC_Queue._i = tmp;
        }
        VC_Queue._i.push({ t:type, i:id, v:val });
        VC_Queue._run();
    },
    _run: function() {
        if (VC_Queue._b || !VC_Queue._i.length) return;
        VC_Queue._b = true;
        let tk = VC_Queue._i[0];
        let tmp = []; let j = 1;
        while (j < VC_Queue._i.length) { tmp.push(VC_Queue._i[j]); j++; }
        VC_Queue._i = tmp;
        Shelly.call(tk.t + '.Set', { id:tk.i, value:tk.v }, function() {
            VC_Queue._b = false;
            // Refresh sync lock while writes still in flight — prevents swing
            // double-fire when queue processing outlasts the fixed 1500ms window
            if (sync_lock && TIMERS.sync_lock !== null) {
                Timer.clear(TIMERS.sync_lock);
                TIMERS.sync_lock = Timer.set(SYNC_LOCK_MS, false, function() {
                    sync_lock = false; TIMERS.sync_lock = null;
                });
            }
            VC_Queue._run();
        });
    }
};

// ── HA_QUEUE — OUTBOUND HTTP QUEUE (B03+B12) ────────────────────
// Serialises all HTTP.Request calls to HA climate services.
// Tracks ha_fail_count (hfc) for health display in status text.
// Success resets hfc to 0. Failure increments it.
// HA_Queue — serial HTTP queue with health tracking
// Note: mJS has no Array.shift() — use index 0 + while-loop rebuild
let HA_Queue = {
    _i: [], _b: false,
    add: function(svc, pay) {
        if (HA_Queue._i.length >= QUEUE_MAX) {
            let tmp = []; let j = 1;
            while (j < HA_Queue._i.length) { tmp.push(HA_Queue._i[j]); j++; }
            HA_Queue._i = tmp;
        }
        HA_Queue._i.push({ s:svc, p:pay });
        HA_Queue._run();
    },
    _run: function() {
        if (HA_Queue._b || !HA_Queue._i.length) return;
        HA_Queue._b = true;
        let tk = HA_Queue._i[0];
        let tmp = []; let j = 1;
        while (j < HA_Queue._i.length) { tmp.push(HA_Queue._i[j]); j++; }
        HA_Queue._i = tmp;
        tk.p.entity_id = CONFIG.entity;
        debugLog('[CB] HA→' + tk.s);
        Shelly.call('HTTP.Request', {
            method: 'POST',
            url:    CONFIG.url + '/api/services/climate/' + tk.s,
            headers: { 'Authorization': 'Bearer ' + CONFIG.token,
                       'Content-Type':  'application/json' },
            body: JSON.stringify(tk.p)
        }, function(res, err) {
            HA_Queue._b = false;
            if (err === 0 && res && res.code === 200) {
                hfc = 0;
            } else {
                hfc++;
                console.log('[CB] HA FAIL ' + tk.s + ' e=' + err + ' c=' + (res ? res.code : 0));
            }
            updateStatus(buildStatusText());
            HA_Queue._run();
        });
    }
};

// Value mapper
function mapValue(table, key, fallback) {
    if (!table || !key) return fallback;
    let v = table[key];
    return (v !== undefined) ? v : fallback;
}

// ── HANDLE STATE — INBOUND SYNC ENGINE (B09) ────────────────────
// Called by both the HTTP endpoint (PUSH from HA automation) and
// syncFromHA (GET on boot). Also called with CACHE on reboot.
// Writes all VCs via VC_Queue. Arms sync_lock to prevent echo.
// LAST_VC dedup skips writes where value matches what Brain last set —
// this prevents the statusHandler from treating our own writes as user input.
// handleState — inbound sync engine
function handleState(data, source) {
    if (!data) return;
    // Note: || null accepts 0 as falsy — acceptable for AC temp/humidity ranges
    let temp  = data.temp         || null;
    let hvac  = data.hvac         || null;
    let fan   = data.fan          || null;
    let swing = data.swing        || null;
    let cur_t = data.current_temp || null;
    let hum   = data.humidity     || null;

    debugLog('[CB] sync [' + source + '] hvac=' + hvac + ' fan=' + fan + ' t=' + temp);

    if (temp  !== null) CACHE.temp  = temp;
    if (hvac  !== null) CACHE.hvac  = hvac;
    if (fan   !== null) CACHE.fan   = fan;
    if (swing !== null) CACHE.swing = swing;
    if (cur_t !== null) CACHE.current_temp = cur_t;
    if (hum   !== null) CACHE.humidity     = hum;
    if (hvac !== null && hvac !== 'off') CACHE.last_mode = hvac;

    saveJSON('last_state', CACHE);

    sync_lock = true;
    if (TIMERS.sync_lock !== null) Timer.clear(TIMERS.sync_lock);
    TIMERS.sync_lock = Timer.set(SYNC_LOCK_MS, false, function() {
        sync_lock = false; TIMERS.sync_lock = null;
    });

    // Only write VC if value has changed — prevents statusHandler echo
    // which would trigger outbound path and create feedback loops
    if (temp !== null && temp !== LAST_VC.temp) {
        LAST_VC.temp = temp;
        VC_Queue.add('Number', CONFIG.vc.temp, temp);
    }
    if (hvac !== null && MAPS.toShelly.mode) {
        let m = mapValue(MAPS.toShelly.mode, hvac, null);
        if (m && m !== LAST_VC.mode) {
            LAST_VC.mode = m;
            VC_Queue.add('Enum', CONFIG.vc.mode, m);
        }
    }
    if (fan !== null && MAPS.toShelly.fan) {
        let f = mapValue(MAPS.toShelly.fan, fan, null);
        if (f && f !== LAST_VC.fan) {
            LAST_VC.fan = f;
            VC_Queue.add('Enum', CONFIG.vc.fan, f);
        }
    }
    if (HAS_SWING && swing !== null && MAPS.toShelly.swing) {
        let sw = mapValue(MAPS.toShelly.swing, swing, null);
        if (sw && sw !== LAST_VC.swing) {
            LAST_VC.swing = sw;
            VC_Queue.add('Enum', CONFIG.vc.swing, sw);
        }
    }
    if (HAS_POWER && hvac !== null) {
        let pwr = hvac !== 'off';
        if (pwr !== LAST_VC.power) {
            LAST_VC.power = pwr;
            VC_Queue.add('Boolean', CONFIG.vc.power, pwr);
        }
    }
    if (HAS_ROOM_VC && cur_t !== null) VC_Queue.add('Number', CONFIG.vc.room_temp, cur_t);
    if (HAS_ROOM_VC && hum   !== null) VC_Queue.add('Number', CONFIG.vc.room_hum,  hum);

    updateStatus(buildStatusText());
}

// ── HTTP ENDPOINT — INBOUND PUSH FROM HA (B10) ──────────────────
// HA automation posts to http://SHELLY_IP/script/{id}/sync after every
// climate entity state change. Shelly firmware pre-parses JSON bodies
// when content_type: application/json — req.body arrives as an object,
// not a string. Both cases handled.
// HTTP endpoint — inbound push from HA
function registerEndpoint() {
    HTTPServer.registerEndpoint('sync', function(req, res) {
        if (req.method === 'POST' && req.body) {
            // Shelly pre-parses JSON when content_type is application/json
            // req.body may already be an object — detect and handle both cases
            let body = (typeof req.body === 'object') ? req.body : safeParse(req.body, 'ep');
            if (body) { hfc = 0; handleState(body, 'PUSH'); }
        }
        res.code = 200; res.send();
    });
    debugLog('[CB] /sync registered');
}

// ── STATUS HANDLER — OUTBOUND SYNC (B11) ────────────────────────
// Fires on every VC status notification. Filters to only the 5 relevant
// components. Two-layer echo prevention:
//   1. Source check: rpc/loopback = Brain's own write = skip
//   2. LAST_VC check: value matches last write = echo = skip
// Debounce (800ms) accumulates rapid slider changes before sending to HA.
// Optimistic CACHE update: status text reflects change immediately without
// waiting for HA to push back.
// statusHandler — outbound sync with debounce
function registerStatusHandler() {
    Shelly.addStatusHandler(function(ev) {
        if (!ev.delta || ev.delta.value === undefined) return;
        let comp    = ev.component;

        // BTHome room sensor updates — refresh status text immediately
        if (comp === 'bthomesensor:201' && typeof ev.delta.value === 'number') {
            room_t = ev.delta.value;
            updateStatus(buildStatusText());
            return;
        }
        if (comp === 'bthomesensor:200' && typeof ev.delta.value === 'number') {
            room_h = ev.delta.value;
            updateStatus(buildStatusText());
            return;
        }

        if (!CONFIG.token) return;
        let isTemp  = (comp === 'number:'  + CONFIG.vc.temp);
        let isMode  = (comp === 'enum:'    + CONFIG.vc.mode);
        let isFan   = (comp === 'enum:'    + CONFIG.vc.fan);
        let isSwing = HAS_SWING && (comp === 'enum:'    + CONFIG.vc.swing);
        let isPower = HAS_POWER && (comp === 'boolean:' + CONFIG.vc.power);
        if (!isTemp && !isMode && !isFan && !isSwing && !isPower) return;

        let src   = ev.delta.source;
        let isNet = (src === 'rpc' || src === 'loopback');

        if (!isNet && sync_lock) {
            debugLog('[CB] user override — break lock');
            sync_lock = false;
            if (TIMERS.sync_lock !== null) { Timer.clear(TIMERS.sync_lock); TIMERS.sync_lock = null; }
        }
        if (sync_lock || isNet) return;

        let cComp = comp;
        let cVal  = ev.delta.value;

        // Echo guard — enum writes from VC_Queue may not carry source='rpc'/'loopback'
        // If value matches what we last wrote, this is our own write echoing back — skip
        if (isTemp  && cVal === LAST_VC.temp)  return;
        if (isMode  && cVal === LAST_VC.mode)  return;
        if (isFan   && cVal === LAST_VC.fan)   return;
        if (isSwing && cVal === LAST_VC.swing) return;
        if (isPower && cVal === LAST_VC.power) return;

        if (TIMERS.debounce !== null) { Timer.clear(TIMERS.debounce); TIMERS.debounce = null; }
        TIMERS.debounce = Timer.set(DEBOUNCE_MS, false, function() {
            TIMERS.debounce = null;
            debugLog('[CB] out: ' + cComp + '=' + cVal);

            // Optimistic CACHE + LAST_VC update — status stays current,
            // and LAST_VC dedup suppresses the echo PUSH when it arrives
            if (isTemp) {
                CACHE.temp = cVal; LAST_VC.temp = cVal;
                HA_Queue.add('set_temperature', { temperature: cVal });
            } else if (isMode) {
                let m = mapValue(MAPS.toHA.mode, cVal, null);
                if (m) {
                    CACHE.hvac = m;
                    if (m !== 'off') CACHE.last_mode = m;
                    LAST_VC.mode = cVal; // Shelly label (not HA string)
                    HA_Queue.add('set_hvac_mode', { hvac_mode: m });
                }
            } else if (isFan) {
                let f = mapValue(MAPS.toHA.fan, cVal, null);
                if (f) {
                    CACHE.fan = f; LAST_VC.fan = cVal;
                    HA_Queue.add('set_fan_mode', { fan_mode: f });
                }
            } else if (isSwing) {
                let sw = mapValue(MAPS.toHA.swing, cVal, null);
                if (sw) {
                    CACHE.swing = sw; LAST_VC.swing = cVal;
                    HA_Queue.add('set_swing_mode', { swing_mode: sw });
                }
            } else if (isPower) {
                if (cVal === false) {
                    CACHE.hvac = 'off'; LAST_VC.power = false;
                    HA_Queue.add('set_hvac_mode', { hvac_mode: 'off' });
                } else {
                    let restore = CACHE.last_mode || 'auto';
                    CACHE.hvac = restore; LAST_VC.power = true;
                    HA_Queue.add('set_hvac_mode', { hvac_mode: restore });
                }
            }

            updateStatus(buildStatusText());
        });
    });
    debugLog('[CB] statusHandler registered');
}

// ── KVS LOADER (B04) ─────────────────────────────────────────────
// Recursive async chain — mJS has no Promise/await.
// Loads bridge_auth → bridge_core → bridge_vc → all 6 map tables.
// Brain reads KVS once on boot then works entirely from RAM.
// Note: bridge_core and bridge_vc are split (combined was ~230B,
// hitting the firmware KVS value limit in practice).
// KVS loader
function kvsGet(key, cb) {
    Shelly.call('KVS.Get', { key:key }, function(res, err) {
        if (err !== 0 || !res || res.value === undefined || res.value === null) { cb(null); return; }
        cb(res.value);
    });
}
function loadMaps(cb) {
    let mk = [
        { k:'bridge_map_mode_ha', t:'toShelly', s:'mode'  },
        { k:'bridge_map_mode_sh', t:'toHA',     s:'mode'  },
        { k:'bridge_map_fan_ha',  t:'toShelly', s:'fan'   },
        { k:'bridge_map_fan_sh',  t:'toHA',     s:'fan'   },
        { k:'bridge_map_swing_ha',t:'toShelly', s:'swing' },
        { k:'bridge_map_swing_sh',t:'toHA',     s:'swing' }
    ];
    let idx = 0;
    function next() {
        if (idx >= mk.length) { cb(); return; }
        let item = mk[idx++];
        kvsGet(item.k, function(val) {
            let p = safeParse(val, item.k);
            if (p) MAPS[item.t][item.s] = p;
            next();
        });
    }
    next();
}
function loadKVS(cb) {
    console.log('[CB] loadKVS');
    kvsGet('bridge_auth', function(v1) {
        if (!v1) { console.log('[CB] FATAL: bridge_auth missing'); return; }
        CONFIG.token = v1;
        kvsGet('bridge_core', function(v2) {
            let c = safeParse(v2, 'bridge_core');
            if (!c || !c.url || !c.entity) { console.log('[CB] FATAL: bridge_core missing'); return; }
            CONFIG.url        = c.url;
            CONFIG.entity     = c.entity;
            CONFIG.debug      = (typeof c.debug      === 'boolean') ? c.debug      : false;
            CONFIG.print_yaml = (typeof c.print_yaml === 'boolean') ? c.print_yaml : false;
            CONFIG.has_bthome = (typeof c.has_bthome === 'boolean') ? c.has_bthome : false;
            kvsGet('bridge_vc', function(v3) {
                let v = safeParse(v3, 'bridge_vc');
                if (v) CONFIG.vc = v;
                debugLog('[CB] CONFIG ' + CONFIG.url + ' | ' + CONFIG.entity);
                loadMaps(cb);
            });
        });
    });
}

// ── FEATURE PROBE (B05) ──────────────────────────────────────────
// Detects optional virtual components by querying GetConfig.
// Sets HAS_SWING, HAS_ROOM_VC, HAS_POWER flags used throughout Brain.
// This makes the Brain gracefully handle any valid SITE_CONFIG combination
// without code changes — just re-run Installer with different flags.
// Feature probe
function probeFeatures(cb) {
    Shelly.call('Enum.GetConfig', { id:CONFIG.vc.swing }, function(r1, e1) {
        HAS_SWING = (e1 === 0 && r1 !== null && r1 !== undefined);
        Shelly.call('Number.GetConfig', { id:CONFIG.vc.room_temp }, function(r2, e2) {
            HAS_ROOM_VC = (e2 === 0 && r2 !== null && r2 !== undefined);
            Shelly.call('Boolean.GetConfig', { id:CONFIG.vc.power }, function(r3, e3) {
                HAS_POWER = (e3 === 0 && r3 !== null && r3 !== undefined);
                debugLog('[CB] probe SWING=' + HAS_SWING + ' ROOM_VC=' + HAS_ROOM_VC + ' POWER=' + HAS_POWER);
                cb();
            });
        });
    });
}

// ── BOOT HELPERS ─────────────────────────────────────────────────
// restoreCachedState: reads last_state from Script.storage — populates
//   CACHE before syncFromHA so status text shows immediately on reboot.
// readBTHome: reads current BTHome sensor values at boot so status text
//   includes room temp/humidity from first render (not next BT broadcast).
// syncFromHA: GET /api/states/{entity} — populates VCs from live HA state.
// printYAML: logs rest_command URL to console when print_yaml:true in KVS.
// Boot helpers
function readBTHome(cb) {
    // Read current BTHome sensor values at boot for immediate status text
    Shelly.call('BTHomeSensor.GetStatus', { id: 201 }, function(r1, e1) {
        if (e1 === 0 && r1 && typeof r1.value === 'number') room_t = r1.value;
        Shelly.call('BTHomeSensor.GetStatus', { id: 200 }, function(r2, e2) {
            if (e2 === 0 && r2 && typeof r2.value === 'number') room_h = r2.value;
            debugLog('[CB] BTHome boot: t=' + room_t + ' h=' + room_h);
            if (cb) cb();
        });
    });
}

function restoreCachedState() {
    let raw = Script.storage.getItem('last_state');
    if (!raw) { debugLog('[CB] no cache'); return; }
    let p = safeParse(raw, 'cache');
    if (p) handleState(p, 'CACHE');
}
function syncFromHA(cb) {
    debugLog('[CB] syncFromHA');
    Shelly.call('HTTP.Request', {
        method:  'GET',
        url:     CONFIG.url + '/api/states/' + CONFIG.entity,
        headers: { 'Authorization': 'Bearer ' + CONFIG.token }
    }, function(res, err) {
        if (err === 0 && res && res.code === 200) {
            let p = safeParse(res.body, 'initSync');
            if (p) {
                let a = p.attributes || {};
                handleState({
                    temp: a.temperature || null,         hvac: p.state || null,
                    fan:  a.fan_mode || null,            swing: a.swing_mode || null,
                    current_temp: a.current_temperature || null,
                    humidity: a.humidity || null
                }, 'INIT');
            }
        } else {
            console.log('[CB] syncFromHA fail e=' + err + ' c=' + (res ? res.code : 0));
        }
        if (cb) cb();
    });
}
function printYAML() {
    Shelly.call('Wifi.GetStatus', {}, function(res) {
        let ip  = (res && res.sta_ip) ? res.sta_ip : 'SHELLY_IP';
        console.log('[CB] YAML url: http://' + ip + '/script/' + SELF_ID + '/sync');
        console.log('[CB] YAML entity: ' + CONFIG.entity);
    });
}

// ── BOOT SEQUENCE ────────────────────────────────────────────────
// Order is mandatory. Each step feeds the next.
// Boot sequence
function init() {
    console.log('[CB] Brain v' + VERSION + ' boot');
    SELF_ID = Shelly.getCurrentScriptId();
    loadKVS(function() {
        probeFeatures(function() {
            registerEndpoint();
            registerStatusHandler();
            readBTHome(function() {
                restoreCachedState();
                syncFromHA(function() {
                    if (CONFIG.print_yaml) printYAML();
                    console.log('[CB] Boot complete SWING=' + HAS_SWING + ' POWER=' + HAS_POWER + ' ROOM_VC=' + HAS_ROOM_VC);
                });
            });
        });
    });
}

init();
