'use strict';

const Homey    = require('homey');
const protocol = require('../../lib/togrill-protocol');

const RECONNECT_MS   = 10_000;
const POLL_MS        = 10_000;   // fallback read-poll interval
const BATTERY_WARN   = 20;
const AMBIENT_CRIT   = 280;
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

    this._trgReachedTarget = this.homey.flow.getDeviceTriggerCard('probe_reached_target');
    this._trgDisconnected  = this.homey.flow.getDeviceTriggerCard('probe_disconnected');
    this._trgAmbientCrit   = this.homey.flow.getDeviceTriggerCard('ambient_critical');
    this._trgBatteryLow    = this.homey.flow.getDeviceTriggerCard('battery_low');

    // Migration: add capabilities introduced in updates to already-paired
    // devices (new caps only auto-apply to freshly-paired devices otherwise).
    await this._ensureCapabilities();

    this.registerCapabilityListener('togrill_target.probe1', v => this._setTarget(0, v));
    this.registerCapabilityListener('togrill_target.probe2', v => this._setTarget(1, v));
    this.registerCapabilityListener('togrill_timer.probe1',  v => this._setTimer(0, v));
    this.registerCapabilityListener('togrill_min.probe1',    v => this._setMin(0, v));
    this.registerCapabilityListener('togrill_max.probe1',    v => this._setMax(0, v));
    this.registerCapabilityListener('togrill_grill_type.probe1', v => this._setGrillType(0, v));
    this.registerCapabilityListener('togrill_grill_type.probe2', v => this._setGrillType(1, v));
    this.registerCapabilityListener('togrill_taste.probe1',      v => this._setTaste(0, v));
    this.registerCapabilityListener('togrill_taste.probe2',      v => this._setTaste(1, v));

    this._startWatchdog();
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
    if (this._probeDisconnectTimer) this.homey.clearTimeout(this._probeDisconnectTimer);
    if (this._peripheral) {
      await this._peripheral.disconnect().catch(() => {});
      this._peripheral = null;
    }
  }

  async onUninit() {
    this._stopWatchdog();
    this._stopPoll();
    if (this._probeDisconnectTimer) this.homey.clearTimeout(this._probeDisconnectTimer);
    if (this._peripheral) {
      await this._peripheral.disconnect().catch(() => {});
      this._peripheral = null;
    }
  }

  // Add new sub-capabilities (with their per-probe titles) to existing devices.
  async _ensureCapabilities() {
    const NEW_CAPS = {
      'togrill_grill_type.probe1': { en: 'Grill Type – Probe 1', sv: 'Grilltyp – Sond 1' },
      'togrill_grill_type.probe2': { en: 'Grill Type – Probe 2', sv: 'Grilltyp – Sond 2' },
      'togrill_taste.probe1':      { en: 'Taste – Probe 1',      sv: 'Stekgrad – Sond 1' },
      'togrill_taste.probe2':      { en: 'Taste – Probe 2',      sv: 'Stekgrad – Sond 2' },
    };
    for (const [cap, title] of Object.entries(NEW_CAPS)) {
      if (!this.hasCapability(cap)) {
        try {
          await this.addCapability(cap);
          await this.setCapabilityOptions(cap, { title });
          this.log(`Added capability ${cap}`);
        } catch (e) {
          this.error(`addCapability ${cap} failed: ${e.message}`);
        }
      }
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

  _startPoll() {
    this._stopPoll();
    let tick = 0;
    this._pollTimer = this.homey.setInterval(async () => {
      if (!this._peripheral || !this._writeChar) return;
      try {
        // Ask for fresh temperatures every tick; refresh status (battery,
        // probe count) less often — once per ~6 ticks (~1 min at 10s).
        await this._requestTemperatures();
        if (tick % 6 === 0) await this._requestStatus();
        tick++;
      } catch (e) {
        this.log(`POLL request failed: ${e.message}`);
      }
    }, POLL_MS);
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
    this._deviceStatus = p;
    this.setCapabilityValue('measure_battery', p.battery).catch(this.error);
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

  _onTemperatures(p) {
    const probeNames = ['probe1', 'probe2', 'probe3', 'probe4'];
    const probeCount = this._deviceStatus ? this._deviceStatus.probeCount : 4;
    const hasAmbient = this._deviceStatus ? this._deviceStatus.hasAmbient  : false;

    // Probe channels
    for (let i = 0; i < probeCount && i < p.channels.length; i++) {
      const temp = p.channels[i];
      const name = probeNames[i];

      if (temp !== null) {
        this.setCapabilityValue(`measure_temperature.${name}`, temp).catch(this.error);
        if (this._disconnectedSet.has(i)) {
          this._disconnectedSet.delete(i);
          if (this._disconnectedSet.size === 0) {
            this._clearProbeDisconnected();
          }
        }
      } else {
        if (!this._disconnectedSet.has(i)) {
          this._disconnectedSet.add(i);
          this._raiseProbeDisconnected();
          this._trgDisconnected
            .trigger(this, { probe: i + 1 }, {})
            .catch(this.error);
        }
      }
    }

    // Ambient channel. The AT-02 always reports it as the LAST channel of the
    // A1 frame (confirmed on-device: heating the clip sensor moved channel 6 of
    // 7, while probe channels stayed flat). The slots between the probes and the
    // ambient are 0xFFFF filler, so index it from the end, not at `probeCount`.
    if (hasAmbient && p.channels.length > probeCount) {
      const ambient = p.channels[p.channels.length - 1];
      if (ambient !== null) {
        this.setCapabilityValue('measure_temperature.ambient', ambient).catch(this.error);
        const isCrit = ambient > AMBIENT_CRIT;
        this.setCapabilityValue('alarm_generic.ambient_high', isCrit).catch(this.error);
        if (isCrit) {
          this._trgAmbientCrit
            .trigger(this, { temperature: ambient }, {})
            .catch(this.error);
        }
      }
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

    // Reflect the device's current cooking preset for the probes we expose (1-2).
    const n = p.probe + 1;
    if (n === 1 || n === 2) {
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
