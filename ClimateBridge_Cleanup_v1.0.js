// ⚡ SPARK_LABS: Climate Bridge — Cleanup Utility v1.0
//
// WHAT THIS SCRIPT DOES
//   Removes all Climate Bridge virtual components and KVS keys from a device.
//   Resets the device to a clean state ready for fresh Installer run.
//
// SAFE TO USE
//   BTHome device/sensor components: NEVER touched
//   gree_ legacy KVS keys: NOT deleted (different prefix)
//   Scripts: NOT touched
//
// USAGE
//   1. Set DO_DELETE = false — dry run lists what would be deleted
//   2. Verify the list looks correct
//   3. Set DO_DELETE = true — run again to execute
//   4. Run ClimateBridge_Installer_v1.0.js to reinstall

// ── CONFIG ─────────────────────────────────────────────────────
// Set to false to do a DRY RUN first (lists what would be deleted)
const DO_DELETE = true;
// KVS prefix to wipe — only keys starting with this string
const KVS_PREFIX = 'bridge_';
// ───────────────────────────────────────────────────────────────

let _q  = [];
let _qi = 0;

function qadd(method, params) {
    _q.push({ m: method, p: params });
}

function qrun() {
    if (_qi >= _q.length) { onComplete(); return; }
    let task = _q[_qi];
    _qi++;
    Shelly.call(task.m, task.p, function(res, err, errmsg) {
        if (err !== 0) {
            console.log('[CLEAN] WARN ' + task.m + ' ' + JSON.stringify(task.p) + ' e=' + err);
        } else {
            console.log('[CLEAN] OK   ' + task.m + ' ' + JSON.stringify(task.p));
        }
        Timer.set(200, false, qrun);
    });
}

function onComplete() {
    console.log('');
    console.log('[CLEAN] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    if (DO_DELETE) {
        console.log('[CLEAN] DONE — VCs and KVS keys deleted');
    } else {
        console.log('[CLEAN] DRY RUN COMPLETE');
        console.log('[CLEAN] Set DO_DELETE = true to execute');
    }
    console.log('[CLEAN] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    Shelly.call('Script.Stop', { id: Shelly.getCurrentScriptId() });
}

// ── Step 1: Collect and delete virtual components ─────────────

function deleteVCs(offset) {
    Shelly.call('Shelly.GetComponents', { dynamic_only: true, offset: offset }, function(res, err) {
        if (err !== 0 || !res) {
            console.log('[CLEAN] GetComponents failed');
            deleteKVS(0);
            return;
        }

        let items = res.components || [];
        let i;
        for (i = 0; i < items.length; i++) {
            let key = items[i].key;
            // Skip bthome device/sensor components — Brain does not own these
            if (key.indexOf('bthome') === 0) {
                console.log('[CLEAN] SKIP ' + key + ' (BTHome)');
                continue;
            }
            // Skip scripts — only virtual components
            if (key.indexOf('script') === 0) continue;
            // Only target virtual component types
            if (key.indexOf('boolean:')  !== 0 &&
                key.indexOf('number:')   !== 0 &&
                key.indexOf('enum:')     !== 0 &&
                key.indexOf('text:')     !== 0 &&
                key.indexOf('group:')    !== 0) continue;

            if (DO_DELETE) {
                console.log('[CLEAN] queue delete: ' + key);
                qadd('Virtual.Delete', { key: key });
            } else {
                console.log('[CLEAN] DRY would delete VC: ' + key);
            }
        }

        // Paginate if more components exist
        let total = res.total || 0;
        let next_offset = offset + items.length;
        if (next_offset < total) {
            Timer.set(100, false, function() { deleteVCs(next_offset); });
        } else {
            // All VCs queued — now collect KVS keys
            collectKVS();
        }
    });
}

// ── Step 2: Collect and delete bridge_ KVS keys ───────────────

function collectKVS() {
    Shelly.call('KVS.GetMany', { match: KVS_PREFIX + '*' }, function(res, err) {
        if (err !== 0 || !res || !res.items) {
            console.log('[CLEAN] KVS.GetMany failed or empty — skipping KVS delete');
            qrun();
            return;
        }

        let keys = [];
        let i;
        // KVS.GetMany returns array of {key, value} objects — not a dictionary
        for (i = 0; i < res.items.length; i++) {
            keys.push(res.items[i].key);
        }

        console.log('[CLEAN] KVS keys found: ' + keys.length);
        let i;
        for (i = 0; i < keys.length; i++) {
            if (DO_DELETE) {
                console.log('[CLEAN] queue delete KVS: ' + keys[i]);
                qadd('KVS.Delete', { key: keys[i] });
            } else {
                console.log('[CLEAN] DRY would delete KVS: ' + keys[i]);
            }
        }

        // Start the delete queue
        qrun();
    });
}

// ── Entry point ───────────────────────────────────────────────

console.log('[CLEAN] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('[CLEAN] Climate Bridge Cleanup Utility v1.0');
console.log('[CLEAN] DO_DELETE = ' + DO_DELETE);
console.log('[CLEAN] KVS_PREFIX = ' + KVS_PREFIX);
console.log('[CLEAN] ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('');

deleteVCs(0);
