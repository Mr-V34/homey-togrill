'use strict';

const Homey    = require('homey');
const protocol = require('../../lib/togrill-protocol');

const RECONNECT_MS   = 10_000;
const POLL_MS        = 10_000;   // fallback read-poll interval
const BATTERY_WARN   = 20;
const DEFAULT_MIN_C  = 20;
const DEFAULT_MAX_C  = 100;
const PROBE_DISCONNECT_RESET_MS = 5 * 60_000;  // auto-clear a stuck probe-disconnect alarm after 5 min

class ToGrillDevice extends Homey.Device {

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onInit() {
    this.log(`Device init: "${this.getName()}"`);

    this._peripheral      = null;
    this._notifyChar      = null;
    this._writeChar       = null;
    this._reconnectTimer  = null;
    this._pollTimer       = null;
    this._deviceStatus    = null;
    this._disconnectedSet = new Set();
    this._probeDisconnectTimer = null;
    this._connectErr      = null;
    this._lastRawHex      = null;
    this._lastRawTime     = 0;  // tracks which probe indices are currently disconnected
    this._lastAmbient     = null;  // last grill (ambient) temp, for threshold re-evaluation
    this._prevActive      = new Set();  // probe indices that reported a temp on the previous frame
    this._lastChannels    = [];         // last raw A1 channel temps (null = unplugged)
    this._visSig          = null;       // signature of the currently-shown probe/ambient set
    this._rssiTimer       = null;       // dedicated 1-minute signal-strength refresh
    this._lastBattery     = null;       // last known battery %, preserved across the battery-cap migration

    this._trgReachedTarget = this.homey.flow.getDeviceTriggerCard('probe_reached_target');
    this._trgDisconnected  = this.homey.flow.getDeviceTriggerCard('probe_disconnected');
    this._trgAmbientCrit   = this.homey.flow.getDeviceTriggerCard('ambient_critical');
    this._trgGrillLow      = this.homey.flow.getDeviceTriggerCard('grill_temp_low');
    this._trgBatteryLow    = this.homey.flow.getDeviceTriggerCard('battery_low');

    // Migration: add capabilities introduced in updates to already-paired
    // devices (new caps only auto-apply to freshly-paired devices otherwise).
    await this._ensureCapabilities();
    await this._migrateBatteryDisplay();

    // Register capability listeners for every control capability that currently
    // exists. Capabilities hidden for unplugged probes get their listener back
    // when _setCapVisible() re-adds them, so we only register what's present now.
    for (let n = 1; n <= 4; n++) {
      for (const { cap } of this._probeCaps(n)) this._registerListenerFor(cap);
    }
    for (const { cap } of this._ambientCaps()) this._registerListenerFor(cap);

    // Initialise the grill thresholds to 0 (= disabled) when unset.
    for (const cap of ['togrill_min.ambient', 'togrill_max.ambient']) {
      if (this.hasCapability(cap) && this.getCapabilityValue(cap) == null) {
        await this.setCapabilityValue(cap, 0).catch(() => {});
      }
    }

    this._startWatchdog();
    this._startRssiPoll();
    await this._connect();
  }

  async onAdded() {
    this.log(`Device "${this.getName()}" added`);
    await this.setSettings({ ble_uuid: this.getStoreValue('peripheralUuid') || 'Unknown' })
      .catch(() => {});
  }

  async onDeleted() {
    this._stopWatchdog();
    this._stopPoll();
    this._stopRssiPoll();
    if (this._probeDisconnectTimer) this.homey.clearTimeout(this._probeDisconnectTimer);
    if (this._peripheral) {
      await this._peripheral.disconnect().catch(() => {});
      this._peripheral = null;
    }
  }

  async onUninit() {
    this._stopWatchdog();
    this._stopPoll();
    this._stopRssiPoll();
    if (this._probeDisconnectTimer) this.homey.clearTimeout(this._probeDisconnectTimer);
    if (this._peripheral) {
      await this._peripheral.disconnect().catch(() => {});
      this._peripheral = null;
    }
  }

  // Ensure the always-present base capabilities exist on already-paired devices.
  // The per-probe and ambient capabilities are NOT added here — their visibility
  // is driven dynamically by _syncProbeVisibility() so unplugged probes and a
  // missing grill sensor stay hidden instead of cluttering the device view.
  async _ensureCapabilities() {
    const base = {
      'togrill_rssi':                     null,  // capability defines its own title
      'togrill_battery':                  null,  // capability defines its own title
      'alarm_generic.probe_disconnected': { en: 'Probe Disconnected', sv: 'Sond urkopplad' },
    };
    for (const [cap, title] of Object.entries(base)) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
          if (title) await this.setCapabilityOptions(cap, { title });
          this.log(`Added capability ${cap}`);
        } catch (e) {
          this.error(`addCapability ${cap} failed: ${e.message}`);
        }
      }
    }
  }

  // v1.4.0: the standard measure_battery is rendered by Homey as a separate
  // battery element (driven by energy.batteries) and never sits in the sensor
  // grid next to the signal strength. Replace it with a plain togrill_battery
  // sensor and place signal + battery side by side. Runtime-added capabilities
  // append at the end of the tile order, so we remove and re-add both to make
  // them adjacent — once, guarded by a store flag.
  async _migrateBatteryDisplay() {
    if (this.hasCapability('measure_battery')) {
      const v = this.getCapabilityValue('measure_battery');
      if (v != null) this._lastBattery = v;
      await this.removeCapability('measure_battery')
        .catch(e => this.error(`removeCapability measure_battery failed: ${e.message}`));
    }
    if (this.getStoreValue('battSig_v140')) return;
    try {
      if (this.hasCapability('togrill_rssi'))    await this.removeCapability('togrill_rssi');
      if (this.hasCapability('togrill_battery')) await this.removeCapability('togrill_battery');
      await this.addCapability('togrill_rssi');
      await this.addCapability('togrill_battery');
      if (this._lastBattery != null) {
        await this.setCapabilityValue('togrill_battery', this._lastBattery).catch(() => {});
      }
      await this.setStoreValue('battSig_v140', true);
      this.log('Placed signal strength + battery side by side');
    } catch (e) {
      this.error(`Battery/signal reorder failed: ${e.message}`);
    }
  }

  // The capabilities belonging to one probe, in display order (grouped per probe
  // so the whole probe appears/disappears as one block). Titles are applied when
  // the capability is (re-)added at runtime.
  _probeCaps(n) {
    return [
      { cap: `measure_temperature.probe${n}`, title: { en: `Probe ${n}`,           sv: `Sond ${n}` } },
      { cap: `togrill_target.probe${n}`,      title: { en: `Target – Probe ${n}`,  sv: `Mål – Sond ${n}` } },
      { cap: `togrill_min.probe${n}`,         title: { en: `Min – Probe ${n}`,     sv: `Min – Sond ${n}` } },
      { cap: `togrill_max.probe${n}`,         title: { en: `Max – Probe ${n}`,     sv: `Max – Sond ${n}` } },
      { cap: `togrill_timer.probe${n}`,       title: { en: `Timer – Probe ${n}`,   sv: `Timer – Sond ${n}` } },
      { cap: `togrill_grill_type.probe${n}`,  title: { en: `Grill Type – Probe ${n}`, sv: `Grilltyp – Sond ${n}` } },
      { cap: `togrill_taste.probe${n}`,       title: { en: `Taste – Probe ${n}`,   sv: `Stekgrad – Sond ${n}` } },
      { cap: `alarm_generic.probe${n}`,       title: { en: `Probe ${n} Alarm`,     sv: `Sond ${n}-larm` } },
    ];
  }

  // The grill (ambient) capability block — shown only when the device reports an
  // ambient sensor.
  _ambientCaps() {
    return [
      { cap: 'measure_temperature.ambient', title: { en: 'Grill Temp',     sv: 'Grilltemperatur' } },
      { cap: 'togrill_min.ambient',         title: { en: 'Grill Min',      sv: 'Grill min' } },
      { cap: 'togrill_max.ambient',         title: { en: 'Grill Max',      sv: 'Grill max' } },
      { cap: 'alarm_generic.ambient_high',  title: { en: 'High Grill Temp', sv: 'Hög grilltemperatur' } },
      { cap: 'alarm_generic.ambient_low',   title: { en: 'Low Grill Temp',  sv: 'Låg grilltemperatur' } },
    ];
  }

  // Re-evaluate the grill (ambient) alarms after a Grill Min/Max change. Deferred
  // one tick so the new capability value is committed first. Monitored app-side
  // (the device has no protocol support for ambient thresholds).
  _reEvalGrill() {
    this.homey.setTimeout(() => {
      if (this._lastAmbient != null) this._evaluateAmbientAlarms(this._lastAmbient);
    }, 100);
  }

  // Wire the right capability listener for a (re-)added settable capability.
  // Called at init for existing caps and by _setCapVisible() when one is re-added,
  // because removeCapability() also drops its listener.
  _registerListenerFor(cap) {
    const probe = cap.match(/^(togrill_(?:target|timer|min|max|grill_type|taste))\.probe(\d)$/);
    if (probe) {
      const i = Number(probe[2]) - 1;
      const handlers = {
        togrill_target:     v => this._setTarget(i, v),
        togrill_timer:      v => this._setTimer(i, v),
        togrill_min:        v => this._setMin(i, v),
        togrill_max:        v => this._setMax(i, v),
        togrill_grill_type: v => this._setGrillType(i, v),
        togrill_taste:      v => this._setTaste(i, v),
      };
      if (this.hasCapability(cap)) this.registerCapabilityListener(cap, handlers[probe[1]]);
      return;
    }
    if ((cap === 'togrill_min.ambient' || cap === 'togrill_max.ambient') && this.hasCapability(cap)) {
      this.registerCapabilityListener(cap, async () => { this._reEvalGrill(); });
    }
  }

  // Add a capability (with its title) if it should be shown, or remove it if it
  // should be hidden. Homey appends runtime-added capabilities at the end of the
  // tile order, so we group per probe to keep that ordering intuitive.
  async _setCapVisible(cap, want, title) {
    const has = this.hasCapability(cap);
    if (want && !has) {
      try {
        await this.addCapability(cap);
        if (title) await this.setCapabilityOptions(cap, { title });
        this._registerListenerFor(cap);
      } catch (e) { this.error(`addCapability ${cap} failed: ${e.message}`); }
    } else if (!want && has) {
      try {
        await this.removeCapability(cap);
      } catch (e) { this.error(`removeCapability ${cap} failed: ${e.message}`); }
    }
  }

  // Show only the probes that are currently plugged in (reporting a temperature),
  // and the grill (ambient) block only when the device has that sensor. Called
  // whenever the set of active probes or the ambient flag changes.
  async _syncProbeVisibility(active, hasAmbient) {
    for (let n = 1; n <= 4; n++) {
      const want = active.has(n - 1);
      for (const { cap, title } of this._probeCaps(n)) {
        await this._setCapVisible(cap, want, title);
      }
    }
    for (const { cap, title } of this._ambientCaps()) {
      await this._setCapVisible(cap, hasAmbient, title);
    }
  }

  // ── BLE connection ────────────────────────────────────────────────────────

  async _connect() {
    const uuid = this.getStoreValue('peripheralUuid');
    if (!uuid) {
      this._connectErr = 'No BLE UUID stored — delete and re-pair the device';
      this.error(this._connectErr);
      return;
    }

    try {
      this.log(`Connecting to ${uuid}…`);

      // find() returns a cached advertisement or runs a short scan.
      // If it throws, fall back to a full discover() scan so we get fresh results.
      let ad;
      try {
        ad = await this.homey.ble.find(uuid);
      } catch (findErr) {
        this.log(`find() failed (${findErr.message}) — running discover() as fallback`);
        const all = await this.homey.ble.discover([], 10000);
        this.log(`discover() found ${all.length} device(s): ${all.map(a => `${a.localName || '?'}(${a.uuid})`).join(', ')}`);
        ad = all.find(a => a.uuid === uuid);
        if (!ad) {
          throw new Error(`Device ${uuid} not visible. Found: [${all.map(a => a.localName || a.uuid).join(', ') || 'nothing'}]`);
        }
      }

      this._peripheral = await ad.connect();
      if (typeof ad.rssi === 'number' && this.hasCapability('togrill_rssi')) {
        this.setCapabilityValue('togrill_rssi', ad.rssi).catch(() => {});
      }

      this._peripheral.once('disconnect', () => {
        this.log('BLE disconnected — scheduling immediate reconnect');
        this._peripheral = null;
        this._notifyChar = null;
        this._writeChar  = null;
        // Reconnect after 2 s to give the device time to re-advertise.
        // The watchdog also covers persistent failures.
        this.homey.setTimeout(() => {
          if (!this._peripheral) this._connect().catch(e => this.error(`Reconnect failed: ${e.message}`));
        }, 2000);
      });

      await this._subscribe();
      this._connectErr = null;
      await this.setAvailable();
      this.log('Connected and subscribed');
    } catch (err) {
      this.error(`Connect failed: ${err.message}`);
      this._connectErr = err.message;
      this._peripheral = null;
    }
  }

  async _subscribe() {
    const services = await this._peripheral.discoverServices();
    this.log(`Services: [${services.map(s => s.uuid).join(', ')}]`);

    const service = services.find(s => _uuidMatch(s.uuid, protocol.SERVICE_UUID));
    if (!service) throw new Error(`Service not found. Has: [${services.map(s => s.uuid).join(', ')}]`);

    const chars = await service.discoverCharacteristics();
    this.log(`Chars: [${chars.map(c => c.uuid).join(', ')}]`);

    const notifyChar = chars.find(c => _uuidMatch(c.uuid, protocol.NOTIFY_UUID));
    if (!notifyChar) throw new Error(`Notify char not found. Has: [${chars.map(c => c.uuid).join(', ')}]`);

    // Hold the write characteristic object directly. Calling peripheral.write()
    // with a dashed UUID fails ("no service found") because the SDK stores UUIDs
    // without dashes — using the char object sidesteps that lookup entirely.
    const writeChar = chars.find(c => _uuidMatch(c.uuid, protocol.WRITE_UUID));
    if (!writeChar) throw new Error(`Write char not found. Has: [${chars.map(c => c.uuid).join(', ')}]`);
    this._writeChar = writeChar;

    // Read CCCD before subscribe to see its current state
    try {
      const descs = await notifyChar.discoverDescriptors();
      this.log(`Descriptors: [${descs.map(d => d.uuid).join(', ')}]`);
      const cccd = descs.find(d => _uuidMatch(d.uuid, '2902'));
      if (cccd) {
        try {
          const before = await cccd.read();
          this.log(`CCCD before subscribe: 0x${before.toString('hex')} (0100=notify, 0200=indicate, 0000=off)`);
        } catch (e) {
          this.log(`CCCD read: ${e.message}`);
        }
      }
    } catch (e) {
      this.log(`Descriptor step: ${e.message}`);
    }

    this._notifyChar = notifyChar;
    await this._notifyChar.subscribeToNotifications(data => this._onRaw(data));
    this.log('subscribeToNotifications() resolved');

    // Read CCCD after subscribe — tells us what subscribeToNotifications actually set
    try {
      const descs = await notifyChar.discoverDescriptors();
      const cccd  = descs.find(d => _uuidMatch(d.uuid, '2902'));
      if (cccd) {
        try {
          const after = await cccd.read();
          this.log(`CCCD after subscribe:  0x${after.toString('hex')} (0100=notify, 0200=indicate)`);
        } catch (e) {
          this.log(`CCCD read after: ${e.message}`);
        }
      }
    } catch (e) {}

    // The AT-02 does not stream A0/A1 on its own — it answers requests.
    // Kick off one status + one temperature request now; replies arrive via _onRaw.
    await this._requestStatus();
    await this._requestTemperatures();

    this._startPoll();
    this._updateRssi();  // refresh signal strength immediately on (re)connect
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._reconnectTimer = this.homey.setInterval(async () => {
      if (!this._peripheral) {
        this.log('Reconnect watchdog: attempting connection…');
        await this._connect();
      }
    }, RECONNECT_MS);
  }

  _stopWatchdog() {
    if (this._reconnectTimer) {
      this.homey.clearInterval(this._reconnectTimer);
      this._reconnectTimer = null;
    }
  }

  // Refresh the signal-strength reading on its own fixed 1-minute cadence,
  // independent of the data poll — so RSSI keeps updating even if a temperature
  // request fails. Runs for the lifetime of the device; _updateRssi() no-ops
  // while disconnected.
  _startRssiPoll() {
    this._stopRssiPoll();
    this._rssiTimer = this.homey.setInterval(() => this._updateRssi(), 60_000);
  }

  _stopRssiPoll() {
    if (this._rssiTimer) {
      this.homey.clearInterval(this._rssiTimer);
      this._rssiTimer = null;
    }
  }

  _startPoll() {
    this._stopPoll();
    let tick = 0;
    this._pollTimer = this.homey.setInterval(async () => {
      if (!this._peripheral || !this._writeChar) return;
      try {
        // Ask for fresh temperatures every tick; refresh status (battery,
        // probe count) less often — once per ~6 ticks (~1 min at 10s).
        // Signal strength has its own 1-minute timer (_startRssiPoll).
        await this._requestTemperatures();
        if (tick % 6 === 0) await this._requestStatus();
        tick++;
      } catch (e) {
        this.log(`POLL request failed: ${e.message}`);
      }
    }, POLL_MS);
  }

  // Refresh the Bluetooth signal-strength reading (dBm; closer to 0 = stronger).
  async _updateRssi() {
    if (!this._peripheral) return;
    try {
      if (typeof this._peripheral.updateRssi === 'function') await this._peripheral.updateRssi();
      const rssi = this._peripheral.rssi;
      if (typeof rssi === 'number' && this.hasCapability('togrill_rssi')) {
        this.setCapabilityValue('togrill_rssi', rssi).catch(this.error);
      }
    } catch (e) {
      // updateRssi can fail transiently mid-connection; ignore and retry next poll.
    }
  }

  _stopPoll() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ── Notification dispatch ─────────────────────────────────────────────────

  // The AT-02 repeats each packet several times in rapid succession.
  // Deduplicate: same raw bytes within 500 ms = one logical event.
  _onRaw(data) {
    const hex = Buffer.isBuffer(data) ? data.toString('hex') : String(data);
    const now  = Date.now();
    if (hex === this._lastRawHex && now - this._lastRawTime < 500) return;
    this._lastRawHex  = hex;
    this._lastRawTime = now;
    this.log(`RAW: ${hex}`);
    this._onNotify(data);
  }

  _onNotify(raw) {
    let packet;
    try {
      packet = protocol.parseNotification(raw);
    } catch (err) {
      this.error(`Packet parse failed: ${err.message}  raw=${Buffer.isBuffer(raw) ? raw.toString('hex') : String(raw)}`);
      return;
    }
    this.log(`← ${JSON.stringify(packet)}`);
    switch (packet.type) {
      case 'status':       return this._onStatus(packet);
      case 'temperatures': return this._onTemperatures(packet);
      case 'probe_event':  return this._onProbeEvent(packet);
      case 'alarm_detail': return this._onAlarmDetail(packet);
      case 'command_ack':  return this.log(`Command ack: 0x${(packet.command ?? 0).toString(16)}`);
      default:
        this.log(`Unknown packet: ${packet.type}`);
    }
  }

  // ── Probe-disconnected alarm ──────────────────────────────────────────────

  // Raise the dashboard alarm and arm a 5-minute auto-reset. The reset stops the
  // alarm latching forever on an empty/unused probe slot; a genuinely new
  // disconnect re-raises it (and re-arms the timer). Reconnection clears it
  // immediately via _clearProbeDisconnected().
  _raiseProbeDisconnected() {
    this.setCapabilityValue('alarm_generic.probe_disconnected', true).catch(this.error);
    if (this._probeDisconnectTimer) this.homey.clearTimeout(this._probeDisconnectTimer);
    this._probeDisconnectTimer = this.homey.setTimeout(() => {
      this._probeDisconnectTimer = null;
      this.log('Probe-disconnect alarm auto-reset after 5 min');
      this.setCapabilityValue('alarm_generic.probe_disconnected', false).catch(this.error);
    }, PROBE_DISCONNECT_RESET_MS);
  }

  _clearProbeDisconnected() {
    if (this._probeDisconnectTimer) {
      this.homey.clearTimeout(this._probeDisconnectTimer);
      this._probeDisconnectTimer = null;
    }
    this.setCapabilityValue('alarm_generic.probe_disconnected', false).catch(this.error);
  }

  // ── Packet handlers ───────────────────────────────────────────────────────

  _onStatus(p) {
    const probeCountChanged = !this._deviceStatus
      || this._deviceStatus.probeCount !== p.probeCount
      || this._deviceStatus.hasAmbient !== p.hasAmbient;
    this._deviceStatus = p;
    // Probe count / ambient flag affect which capabilities should be shown —
    // force the next temperature frame to re-evaluate visibility.
    if (probeCountChanged) this._visSig = null;
    this._lastBattery = p.battery;
    this.setCapabilityValue('togrill_battery', p.battery).catch(this.error);
    this.setSettings({
      firmware_version: p.version,
      probe_count:      String(p.probeCount),
      ...(p.alarmInterval != null ? { alarm_interval: p.alarmInterval } : {}),
    }).catch(() => {});

    if (p.battery < BATTERY_WARN) {
      this._trgBatteryLow
        .trigger(this, { battery_level: p.battery }, {})
        .catch(this.error);
    }
  }

  async _onTemperatures(p) {
    const probeNames = ['probe1', 'probe2', 'probe3', 'probe4'];
    const probeCount = this._deviceStatus ? this._deviceStatus.probeCount : 4;
    // Default to "has ambient" until the device tells us otherwise, so we never
    // hide the grill sensor while the status frame is still pending.
    const hasAmbient = this._deviceStatus ? this._deviceStatus.hasAmbient : true;

    // Which probes are plugged in right now, read straight from the raw frame so
    // it works even when a probe's capabilities are currently hidden.
    const active = new Set();
    for (let i = 0; i < probeCount && i < p.channels.length; i++) {
      if (p.channels[i] !== null) active.add(i);
    }
    this._lastChannels = p.channels;

    // Edge-triggered probe-disconnected alarm: only a probe that WAS reporting
    // and now isn't counts as a real mid-cook disconnection. Probes that were
    // never plugged in simply stay hidden (see _syncProbeVisibility) and never
    // raise the alarm.
    for (let i = 0; i < probeCount; i++) {
      const wasActive = this._prevActive.has(i);
      const isActive  = active.has(i);
      if (wasActive && !isActive) {
        if (!this._disconnectedSet.has(i)) {
          this._disconnectedSet.add(i);
          this._raiseProbeDisconnected();
          this._trgDisconnected.trigger(this, { probe: i + 1 }, {}).catch(this.error);
        }
      } else if (isActive && this._disconnectedSet.has(i)) {
        this._disconnectedSet.delete(i);
        if (this._disconnectedSet.size === 0) this._clearProbeDisconnected();
      }
    }
    this._prevActive = active;

    // Show/hide probe and ambient capabilities only when the visible set changes,
    // to avoid churning the tile order on every poll.
    const sig = [...active].sort().join(',') + `|amb:${hasAmbient}`;
    if (sig !== this._visSig) {
      this._visSig = sig;
      await this._syncProbeVisibility(active, hasAmbient);
    }

    // Push the live temperatures for the probes that are shown.
    for (const i of active) {
      const cap = `measure_temperature.${probeNames[i]}`;
      if (this.hasCapability(cap)) this.setCapabilityValue(cap, p.channels[i]).catch(this.error);
    }

    // Ambient channel. The AT-02 always reports it as the LAST channel of the
    // A1 frame (confirmed on-device: heating the clip sensor moved channel 6 of
    // 7, while probe channels stayed flat). The slots between the probes and the
    // ambient are 0xFFFF filler, so index it from the end, not at `probeCount`.
    if (hasAmbient && p.channels.length > probeCount) {
      const ambient = p.channels[p.channels.length - 1];
      if (ambient !== null && this.hasCapability('measure_temperature.ambient')) {
        this.setCapabilityValue('measure_temperature.ambient', ambient).catch(this.error);
        this._evaluateAmbientAlarms(ambient);
      }
    }
  }

  // Compare the grill (ambient) temperature against the user-set Grill Min/Max
  // and drive the high/low alarms. A threshold of 0 means "disabled". Triggers
  // fire only on the false→true edge so we don't spam Flows on every ~1 Hz update.
  _evaluateAmbientAlarms(ambient) {
    if (ambient === null || ambient === undefined) return;
    this._lastAmbient = ambient;

    const max = this.getCapabilityValue('togrill_max.ambient') ?? 0;
    const high = max > 0 && ambient > max;
    if (this.hasCapability('alarm_generic.ambient_high')) {
      const prev = this.getCapabilityValue('alarm_generic.ambient_high');
      this.setCapabilityValue('alarm_generic.ambient_high', high).catch(this.error);
      if (high && !prev) this._trgAmbientCrit.trigger(this, { temperature: ambient }, {}).catch(this.error);
    }

    const min = this.getCapabilityValue('togrill_min.ambient') ?? 0;
    const low = min > 0 && ambient < min;
    if (this.hasCapability('alarm_generic.ambient_low')) {
      const prev = this.getCapabilityValue('alarm_generic.ambient_low');
      this.setCapabilityValue('alarm_generic.ambient_low', low).catch(this.error);
      if (low && !prev) this._trgGrillLow.trigger(this, { temperature: ambient }, {}).catch(this.error);
    }
  }

  _onProbeEvent(p) {
    const names = ['probe1', 'probe2', 'probe3', 'probe4'];
    const name  = names[p.probe] ?? `probe${p.probe + 1}`;
    // Note: the protocol has no "probe connected" event — reconnection is
    // detected when a probe channel reports a real temperature again
    // (see _onTemperatures), which clears the alarm.
    switch (p.message) {
      case 'probe_disconnected':
        this._disconnectedSet.add(p.probe);
        this._raiseProbeDisconnected();
        this._trgDisconnected.trigger(this, { probe: p.probe + 1 }, {}).catch(this.error);
        break;
      case 'above_max':
      case 'below_min':
      case 'probe_alarm':
        this.setCapabilityValue(`alarm_generic.${name}`, true).catch(this.error);
        break;
    }
  }

  _onAlarmDetail(p) {
    const names = ['probe1', 'probe2', 'probe3', 'probe4'];
    const name  = names[p.probe] ?? `probe${p.probe + 1}`;

    // Reflect the device's current cooking preset for the probes we expose (1-4).
    const n = p.probe + 1;
    if (n >= 1 && n <= 4) {
      if (this.hasCapability(`togrill_grill_type.probe${n}`)) {
        this.setCapabilityValue(`togrill_grill_type.probe${n}`, protocol.grillTypeId(p.grillType)).catch(this.error);
      }
      if (this.hasCapability(`togrill_taste.probe${n}`)) {
        this.setCapabilityValue(`togrill_taste.probe${n}`, protocol.tasteId(p.taste)).catch(this.error);
      }
    }

    if (p.alarmType === 1) {
      this.setCapabilityValue(`alarm_generic.${name}`, true).catch(this.error);
      this._trgReachedTarget
        .trigger(this, { probe: p.probe + 1 }, {})
        .catch(this.error);
    }
  }

  // ── Write helpers ─────────────────────────────────────────────────────────

  async _write(buf) {
    if (!this._peripheral || !this._writeChar) {
      this.log('Write: not connected — reconnecting…');
      await this._connect();
    }
    if (!this._peripheral || !this._writeChar) {
      throw new Error(this._connectErr || 'Device not connected');
    }
    this.log(`→ ${buf.toString('hex')}`);
    // Write via the characteristic object, NOT peripheral.write(uuid, uuid, buf):
    // the SDK can't resolve dashed UUIDs and throws "no service found".
    await this._writeChar.write(buf);
  }

  // ── Data requests (request/response — device replies on the notify char) ──────

  async _requestStatus() {
    await this._write(protocol.encodeRequestStatus());
  }

  async _requestTemperatures() {
    await this._write(protocol.encodeRequestTemperatures());
  }

  async _setTarget(probeIdx, tempC) {
    await this._write(protocol.encodeTarget(probeIdx, tempC));
  }

  async _setTimer(probeIdx, seconds) {
    await this._write(protocol.encodeTimer(probeIdx, seconds));
  }

  async _setMin(probeIdx, minC) {
    const maxC = this.getCapabilityValue(`togrill_max.probe${probeIdx + 1}`) ?? DEFAULT_MAX_C;
    await this._write(protocol.encodeRange(probeIdx, minC, maxC));
  }

  async _setMax(probeIdx, maxC) {
    const minC = this.getCapabilityValue(`togrill_min.probe${probeIdx + 1}`) ?? DEFAULT_MIN_C;
    await this._write(protocol.encodeRange(probeIdx, minC, maxC));
  }

  // Grill type + taste share one A3/0x03 packet, so sending one must preserve the
  // other probe-local value. Read the sibling capability and write both together.
  async _setGrillType(probeIdx, grillId) {
    const tId = this.getCapabilityValue(`togrill_taste.probe${probeIdx + 1}`) ?? 'none';
    await this._write(protocol.encodeGrillTaste(
      probeIdx, protocol.GRILL_TYPES[grillId] ?? 0, protocol.TASTES[tId] ?? 0));
  }

  async _setTaste(probeIdx, tasteIdValue) {
    const gId = this.getCapabilityValue(`togrill_grill_type.probe${probeIdx + 1}`) ?? 'none';
    await this._write(protocol.encodeGrillTaste(
      probeIdx, protocol.GRILL_TYPES[gId] ?? 0, protocol.TASTES[tasteIdValue] ?? 0));
  }

  // Public API for flow action cards in driver.js
  async setTarget(probeIdx, tempC)     { return this._setTarget(probeIdx, tempC); }
  async setTimer(probeIdx, seconds)    { return this._setTimer(probeIdx, seconds); }
  async setRange(probeIdx, minC, maxC) { return this._write(protocol.encodeRange(probeIdx, minC, maxC)); }

  async setGrillType(probeIdx, grillId) {
    await this._setGrillType(probeIdx, grillId);
    await this.setCapabilityValue(`togrill_grill_type.probe${probeIdx + 1}`, grillId).catch(this.error);
  }

  async setTaste(probeIdx, tasteIdValue) {
    await this._setTaste(probeIdx, tasteIdValue);
    await this.setCapabilityValue(`togrill_taste.probe${probeIdx + 1}`, tasteIdValue).catch(this.error);
  }

  // Connected probes for Flow autocomplete — a probe counts as connected when it
  // currently reports a temperature. Optionally include the grill (ambient) sensor.
  getProbeChoices(includeAmbient = false) {
    const out = [];
    for (let i = 1; i <= 4; i++) {
      const t = this.getCapabilityValue(`measure_temperature.probe${i}`);
      if (t !== null && t !== undefined) out.push({ id: String(i), name: `Probe ${i}` });
    }
    if (includeAmbient) {
      const a = this.getCapabilityValue('measure_temperature.ambient');
      if (a !== null && a !== undefined) out.push({ id: 'ambient', name: 'Grill (ambient)' });
    }
    return out;
  }

  // Device-settings UI: write alarm interval (minutes) to the device when changed.
  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('alarm_interval')) {
      const interval = Number(newSettings.alarm_interval);
      try {
        await this._write(protocol.encodeAlarmSettings(0, interval));  // 0 = °C, keep unit
        this.log(`Alarm interval set to ${interval} min`);
      } catch (e) {
        this.error(`Failed to write alarm interval: ${e.message}`);
        throw new Error(this.homey.__('errors.not_connected') || 'Device not connected');
      }
    }
  }

}

// Normalise a UUID to bare lowercase hex for comparison.
// Handles both full 128-bit ('0000cee0-0000-1000-8000-00805f9b34fb')
// and short 16-bit ('cee0') forms that Homey may use.
function _uuidMatch(a, b) {
  const norm = u => u.toLowerCase().replace(/-/g, '')
    .replace(/^0000([0-9a-f]{4})00001000800000805f9b34fb$/, '$1');
  return norm(a) === norm(b);
}

module.exports = ToGrillDevice;
