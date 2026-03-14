// ⚡ SPARK_LABS: Climate Bridge — Installer v1.0
// Ref: ClimateBridge_FW_Spec_v1.0
//
// WHAT THIS SCRIPT DOES
//   One-time commissioning script. Edit SITE_CONFIG, run once, then stop.
//   Seeds all bridge_ KVS keys, creates and configures all virtual components,
//   populates the group in locked UI order. Self-stops on completion.
//
// INSTALLATION SEQUENCE
//   Phase 1: KVS writes    — bridge_auth, bridge_core, bridge_vc,
//                            bridge_schema, all 6 map tables (150ms each)
//   Phase 2: VC skeleton   — Virtual.Add with minimal config (400ms each)
//   Phase 3: VC config     — SetConfig with full meta + emoji titles (500-600ms)
//   Phase 4: Group order   — Group.Set in locked UI display order
//   Phase 5: BTHome icons  — BTHomeSensor.SetConfig if has_bthome:true
//
// PREFLIGHT GUARD
//   Aborts if SITE_CONFIG contains placeholder values.
//   Aborts if text:200 already exists (VCs already installed).
//   Run ClimateBridge_Cleanup_v1.0.js first to reset a device.
//
// AFTER INSTALL
//   Flash ClimateBridge_Brain_v1.0.js and set to run on boot.
//   Brain reads everything from KVS — never edit Brain for site config.

// ── OVERRIDE (must be false in production) ─────────────────────
const OVERRIDE = false;
const VERSION  = '1.0';

// ── SITE_CONFIG — edit this block for each deployment ──────────
// DO NOT EDIT BELOW THE LINE
const SITE_CONFIG = {
    ha_token:    'YOUR_TOKEN',
    ha_url:      'http://192.168.1.X:8123',
    entity_id:   'climate.your_ac',
    device_name: 'Bedroom AC',

    // AC capabilities — match your HA climate entity exactly
    modes:       ['Off', 'Auto', 'Heat', 'Cool', 'Fan', 'Dry'],
    fan_speeds:  ['Auto', 'Low', 'Medium', 'High'],
    swing_modes: ['Horizontal', 'Vertical', 'Both', 'Off'], // [] = no swing

    // Hardware options
    has_bthome:       false,          // true = BLU H&T sensor in group
    bthome_ids:       { temp: 201, humidity: 200 },
    add_swing:        true,
    add_power_toggle: true,

    temp_min: 16,
    temp_max: 30,

    // Icons — confirmed working URLs (Icons8)
    icons: {
        status: 'https://img.icons8.com/?size=100&id=rcvmSKzkbMQV&format=png&color=000000',
        temp:   'https://img.icons8.com/?size=100&id=SrPdU210llxl&format=png&color=000000',
        mode:   'https://img.icons8.com/?size=100&id=8xfto67F8tTC&format=png&color=000000',
        fan:    'https://img.icons8.com/?size=100&id=EY8jdypuE1WP&format=png&color=000000',
        swing:  'https://img.icons8.com/?size=100&id=m8O2WtuAF9uu&format=png&color=000000',
        power:  'https://img.icons8.com/?size=100&id=le7JFNVQJ7sV&format=png&color=000000',
        group:  'https://img.icons8.com/?size=100&id=8xfto67F8tTC&format=png&color=000000'
    },

    // Dropdown display titles (raw UTF-8 — no \uXXXX)
    mode_titles:  { 'Off':' ', 'Auto':'🔁', 'Heat':'🔥', 'Cool':'❄️', 'Fan':'💨', 'Dry':'💧' },
    fan_titles:   { 'Auto':'֎ A', 'Low':'֎ L', 'Medium':'֎ M', 'High':'֎ H' },
    swing_titles: { 'Horizontal':'↔️', 'Vertical':'↕️', 'Both':'🔀', 'Off':'🟦' },

    debug: false
};
// ── DO NOT EDIT BELOW THIS LINE ────────────────────────────────

// ── SERIAL QUEUE ──────────────────────────────────────────────────
// Index counter pattern (no Array.shift/splice — banned in mJS).
// Each step fires its callback, then sets a timer before calling qrun()
// for the next step. Timer delay per step is tuned to give firmware
// breathing room between RPC operations (150ms KVS, 400ms Add, 500-600ms SetConfig).
// Serial queue — index counter, no shift/splice (mJS safe)
let _q  = [];
let _qi = 0;

function qadd(method, params, delay_ms) {
    _q.push({ m: method, p: params, d: (delay_ms || 300) });
}

function qrun() {
    if (_qi >= _q.length) { onComplete(); return; }
    let task = _q[_qi];
    _qi++;
    Shelly.call(task.m, task.p, function(res, err, errmsg) {
        if (err !== 0) {
            console.log('[INSTALL] WARN ' + task.m + ' e=' + err + ' ' + (errmsg || ''));
        } else {
            console.log('[INSTALL] OK   ' + task.m);
        }
        Timer.set(task.d, false, qrun);
    });
}

// ── MAP GENERATION ────────────────────────────────────────────────
// Auto-generates bidirectional HA<->Shelly lookup tables from SITE_CONFIG arrays.
// Critical: HA uses "fan_only" for Fan mode — hardcoded in HA_MODE lookup.
// Fan and swing use direct lowercase conversion (proven in I04).
// Maps are stored in KVS as split JSON objects (one key per direction per attribute).
// Map generation — builds bidirectional HA<->Shelly maps from SITE_CONFIG arrays
function generateMaps() {
    let i;

    // Mode map — fan_only special case (HA uses fan_only, Shelly uses Fan)
    let HA_MODE = {};
    HA_MODE['Off']  = 'off';
    HA_MODE['Auto'] = 'auto';
    HA_MODE['Heat'] = 'heat';
    HA_MODE['Cool'] = 'cool';
    HA_MODE['Fan']  = 'fan_only';
    HA_MODE['Dry']  = 'dry';

    let mode_ha = {}, mode_sh = {};
    for (i = 0; i < SITE_CONFIG.modes.length; i++) {
        let sh = SITE_CONFIG.modes[i];
        let ha = HA_MODE[sh] || sh.toLowerCase();
        mode_ha[ha] = sh;
        mode_sh[sh] = ha;
    }

    // Fan map — direct lowercase
    let fan_ha = {}, fan_sh = {};
    for (i = 0; i < SITE_CONFIG.fan_speeds.length; i++) {
        let sh = SITE_CONFIG.fan_speeds[i];
        let ha = sh.toLowerCase();
        fan_ha[ha] = sh;
        fan_sh[sh] = ha;
    }

    // Swing map — direct lowercase (conditional)
    let swing_ha = {}, swing_sh = {};
    let has_swing = (SITE_CONFIG.add_swing && SITE_CONFIG.swing_modes.length > 0);
    if (has_swing) {
        for (i = 0; i < SITE_CONFIG.swing_modes.length; i++) {
            let sh = SITE_CONFIG.swing_modes[i];
            let ha = sh.toLowerCase();
            swing_ha[ha] = sh;
            swing_sh[sh] = ha;
        }
    }

    return {
        mode_ha:  mode_ha,  mode_sh:  mode_sh,
        fan_ha:   fan_ha,   fan_sh:   fan_sh,
        swing_ha: swing_ha, swing_sh: swing_sh,
        has_swing: has_swing
    };
}

// ── GROUP ORDER ───────────────────────────────────────────────────
// Array position = UI display position in Shelly app. Order is LOCKED.
// text:200 (State) always first. boolean:200 (Power) always last.
// BTHome sensors inserted in place of room number VCs when has_bthome:true.
// Conditional items (swing, bthome/room VCs, power) are omitted if not created.
// Build locked group member array
function buildGroupMembers(has_swing) {
    let m = [];
    m.push('text:200');
    m.push('number:200');
    m.push('enum:200');
    m.push('enum:201');
    if (has_swing) m.push('enum:202');
    if (SITE_CONFIG.has_bthome) {
        m.push('bthomesensor:' + SITE_CONFIG.bthome_ids.temp);
        m.push('bthomesensor:' + SITE_CONFIG.bthome_ids.humidity);
    } else {
        m.push('number:201');
        m.push('number:202');
    }
    if (SITE_CONFIG.add_power_toggle) m.push('boolean:200');
    return m;
}

// ── BUILD QUEUE ───────────────────────────────────────────────────
// Assembles the full operation list into _q[]. Nothing executes until qrun().
// Two-phase VC approach: Virtual.Add skeleton (small payload) then
// SetConfig with full meta/titles (larger payload, more breathing room).
// Queue all operations
function buildQueue(maps) {
    let hs = maps.has_swing;

    // ── Phase 1: KVS writes (150ms between each — fast, no firmware overhead) ──

    // bridge_auth — plain token string (not JSON-wrapped)
    qadd('KVS.Set', { key:'bridge_auth', value: SITE_CONFIG.ha_token }, 150);

    // bridge_core — lean config (no vc block — split to bridge_vc to stay under 200B)
    qadd('KVS.Set', { key:'bridge_core', value: JSON.stringify({
        url:        SITE_CONFIG.ha_url,
        entity:     SITE_CONFIG.entity_id,
        debug:      SITE_CONFIG.debug,
        print_yaml: false,
        has_bthome: SITE_CONFIG.has_bthome
    })}, 150);

    // bridge_vc — vc ID map (split from bridge_core to stay under KVS value limit)
    qadd('KVS.Set', { key:'bridge_vc', value: JSON.stringify({
        temp:200, mode:200, fan:201, swing:202, power:200,
        room_temp:201, room_hum:202, status:200, group:200
    })}, 150);

    // bridge_schema
    qadd('KVS.Set', { key:'bridge_schema', value: VERSION }, 150);

    // Maps
    qadd('KVS.Set', { key:'bridge_map_mode_ha', value: JSON.stringify(maps.mode_ha)  }, 150);
    qadd('KVS.Set', { key:'bridge_map_mode_sh', value: JSON.stringify(maps.mode_sh)  }, 150);
    qadd('KVS.Set', { key:'bridge_map_fan_ha',  value: JSON.stringify(maps.fan_ha)   }, 150);
    qadd('KVS.Set', { key:'bridge_map_fan_sh',  value: JSON.stringify(maps.fan_sh)   }, 150);
    if (hs) {
        qadd('KVS.Set', { key:'bridge_map_swing_ha', value: JSON.stringify(maps.swing_ha) }, 150);
        qadd('KVS.Set', { key:'bridge_map_swing_sh', value: JSON.stringify(maps.swing_sh) }, 150);
    }

    // ── Phase 2: VC skeleton — Virtual.Add with minimal config (400ms each) ──
    // Two-phase approach: create skeleton first, configure separately.
    // Smaller payloads on Add — SetConfig carries the heavy meta/titles.

    qadd('Virtual.Add', { type:'text',    id:200, config:{ name:'State',       default_value:'' }}, 400);
    qadd('Virtual.Add', { type:'number',  id:200, config:{ name:'Target Temp', default_value:21, min: SITE_CONFIG.temp_min, max: SITE_CONFIG.temp_max }}, 400);
    qadd('Virtual.Add', { type:'enum',    id:200, config:{ name:'AC Mode',     options: SITE_CONFIG.modes,      default_value:'Off'  }}, 400);
    qadd('Virtual.Add', { type:'enum',    id:201, config:{ name:'Fan Speed',   options: SITE_CONFIG.fan_speeds, default_value:'Auto' }}, 400);
    if (hs) {
        qadd('Virtual.Add', { type:'enum', id:202, config:{ name:'Swing', options: SITE_CONFIG.swing_modes, default_value:'Both' }}, 400);
    }
    if (!SITE_CONFIG.has_bthome) {
        qadd('Virtual.Add', { type:'number', id:201, config:{ name:'Room Temp',     default_value:21, min:-10, max:60  }}, 400);
        qadd('Virtual.Add', { type:'number', id:202, config:{ name:'Room Humidity', default_value:50, min:0,   max:100 }}, 400);
    }
    if (SITE_CONFIG.add_power_toggle) {
        qadd('Virtual.Add', { type:'boolean', id:200, config:{ name:'Power', default_value:false }}, 400);
    }
    qadd('Virtual.Add', { type:'group', id:200, config:{ name: SITE_CONFIG.device_name }}, 400);

    // ── Phase 3: VC configuration — SetConfig with full meta and titles (600ms each) ──
    // Enum SetConfig carries emoji titles — larger payload, needs more breathing room.

    qadd('Text.SetConfig', { id:200, config:{
        name: 'State', max_len: 50, default_value: '',
        meta:{ ui:{ view:'label', icon: SITE_CONFIG.icons.status }}
    }}, 500);

    qadd('Number.SetConfig', { id:200, config:{
        name: 'Target Temp', default_value: 21,
        min: SITE_CONFIG.temp_min, max: SITE_CONFIG.temp_max,
        meta:{ ui:{ view:'slider', unit:'°C', step:1, icon: SITE_CONFIG.icons.temp }}
    }}, 500);

    qadd('Enum.SetConfig', { id:200, config:{
        name: 'AC Mode', options: SITE_CONFIG.modes, default_value: 'Off',
        meta:{ ui:{ view:'dropdown', icon: SITE_CONFIG.icons.mode, titles: SITE_CONFIG.mode_titles }}
    }}, 600);

    qadd('Enum.SetConfig', { id:201, config:{
        name: 'Fan Speed', options: SITE_CONFIG.fan_speeds, default_value: 'Auto',
        meta:{ ui:{ view:'dropdown', icon: SITE_CONFIG.icons.fan, titles: SITE_CONFIG.fan_titles }}
    }}, 600);

    if (hs) {
        qadd('Enum.SetConfig', { id:202, config:{
            name: 'Swing', options: SITE_CONFIG.swing_modes, default_value: 'Both',
            meta:{ ui:{ view:'dropdown', icon: SITE_CONFIG.icons.swing, titles: SITE_CONFIG.swing_titles }}
        }}, 600);
    }

    if (!SITE_CONFIG.has_bthome) {
        qadd('Number.SetConfig', { id:201, config:{
            name: 'Room Temp', default_value: 21, min:-10, max:60,
            meta:{ ui:{ view:'label', unit:'°C', step:0.1 }}
        }}, 500);
        qadd('Number.SetConfig', { id:202, config:{
            name: 'Room Humidity', default_value: 50, min:0, max:100,
            meta:{ ui:{ view:'label', unit:'%', step:1 }}
        }}, 500);
    }

    if (SITE_CONFIG.add_power_toggle) {
        qadd('Boolean.SetConfig', { id:200, config:{
            name: 'Power', default_value: false,
            meta:{ ui:{ view:'toggle', icon: SITE_CONFIG.icons.power }}
        }}, 500);
    }

    qadd('Group.SetConfig', { id:200, config:{
        name: SITE_CONFIG.device_name,
        meta:{ ui:{ view:'list', icon: SITE_CONFIG.icons.group }}
    }}, 500);

    // ── Phase 4: Group population — locked UI order ──────────────────────────
    let members = buildGroupMembers(hs);
    qadd('Group.Set', { id:200, value: members }, 600);

    // ── Phase 5: BTHome sensor icons (when has_bthome: true) ─────────────────
    // BTHome sensors are paired, not created — set icons separately
    if (SITE_CONFIG.has_bthome) {
        qadd('BTHomeSensor.SetConfig', { id: SITE_CONFIG.bthome_ids.temp, config:{
            name: 'Room Temp',
            meta:{ ui:{ icon:'https://img.icons8.com/?size=100&id=HJXiuCWIq3pP&format=png&color=000000' }}
        }}, 400);
        qadd('BTHomeSensor.SetConfig', { id: SITE_CONFIG.bthome_ids.humidity, config:{
            name: 'Room Humidity',
            meta:{ ui:{ icon:'https://img.icons8.com/?size=100&id=xX3hAGmqS7LE&format=png&color=000000' }}
        }}, 400);
    }
}

// Completion
function onComplete() {
    console.log('');
    console.log('[INSTALL] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[INSTALL] INSTALLATION COMPLETE v' + VERSION);
    console.log('[INSTALL] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[INSTALL] Next: flash ClimateBridge_Brain_v1.0.js');
    console.log('[INSTALL] Set Brain to run on boot.');
    Shelly.call('Script.Stop', { id: Shelly.getCurrentScriptId() });
}

// ── PREFLIGHT ─────────────────────────────────────────────────────
// Validates SITE_CONFIG placeholder values are replaced.
// Uses Text.GetStatus as canary — if text:200 exists, VCs are installed.
// Installer is idempotent if you need to re-run: clean first.
// Preflight — validates config and checks VCs not already present
function preflight(cb) {
    // Config gatekeeper
    if (SITE_CONFIG.ha_token.indexOf('YOUR_') !== -1) {
        console.log('[INSTALL] ABORT: ha_token not configured');
        return;
    }
    if (SITE_CONFIG.ha_url.indexOf('192.168.1.X') !== -1) {
        console.log('[INSTALL] ABORT: ha_url not configured');
        return;
    }
    if (SITE_CONFIG.entity_id.indexOf('climate.your') !== -1) {
        console.log('[INSTALL] ABORT: entity_id not configured');
        return;
    }

    // VC existence check — text:200 as canary
    Shelly.call('Text.GetStatus', { id: 200 }, function(res, err) {
        if (err === 0 && res !== null && res !== undefined) {
            console.log('[INSTALL] ABORT: VCs already exist (text:200 found)');
            console.log('[INSTALL] Delete existing VCs manually then re-run.');
            return;
        }
        console.log('[INSTALL] Preflight passed — starting installation');
        cb();
    });
}

// Entry point
function init() {
    console.log('[INSTALL] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('[INSTALL] Climate Bridge Installer v' + VERSION);
    console.log('[INSTALL] Device: ' + SITE_CONFIG.device_name);
    console.log('[INSTALL] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    preflight(function() {
        let maps = generateMaps();
        buildQueue(maps);
        console.log('[INSTALL] Queue: ' + _q.length + ' operations');
        qrun();
    });
}

init();
