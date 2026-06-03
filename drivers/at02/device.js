'use strict';

const Homey    = require('homey');
const protocol = require('../../lib/togrill-protocol');

const RECONNECT_MS   = 30_000;
const BATTERY_WARN   = 20;
const AMBIENT_CRIT   = 280;
const DEFAULT_MIN_C  = 20;
const DEFAULT_MAX_C  = 100;

class ToGrillDevice extends Homey.Device {

  // ── Lifecycle ────────────────────────────────────────────────────────────

  async onInit() {
    this.log(`Device init: "${this.getName()}"`);

    this._peripheral      = null;
    this._notifyChar      = null;
    this._reconnectTimer  = null;
    this._deviceStatus    = null;
    this._disconnectedSet = new Set();  // tracks which probe indices are currently disconnected

    this._trgReachedTarget = this.homey.flow.getDeviceTriggerCard('probe_reached_target');
    this._trgDisconnected  = this.homey.flow.getDeviceTriggerCard('probe_disconnected');
    this._trgAmbientCrit   = this.homey.flow.getDeviceTriggerCard('ambient_critical');
    this._trgBatteryLow    = this.homey.flow.getDeviceTriggerCard('battery_low');

    this.registerCapabilityListener('togrill_target.probe1', v => this._setTarget(0, v));
    this.registerCapabilityListener('togrill_target.probe2', v => this._setTarget(1, v));
    this.registerCapabilityListener('togrill_timer.probe1',  v => this._setTimer(0, v));
    this.registerCapabilityListener('togrill_min.probe1',    v => this._setMin(0, v));
    this.registerCapabilityListener('togrill_max.probe1',    v => this._setMax(0, v));

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
    if (this._peripheral) {
      await this._peripheral.disconnect().catch(() => {});
      this._peripheral = null;
    }
  }

  async onUninit() {
    this._stopWatchdog();
    if (this._peripheral) {
      await this._peripheral.disconnect().catch(() => {});
      this._peripheral = null;
    }
  }

  // ── BLE connection ────────────────────────────────────────────────────────

  async _connect() {
    const uuid = this.getStoreValue('peripheralUuid');
    if (!uuid) { this.error('No peripheralUuid in store — cannot connect'); return; }

    try {
      this.log(`Connecting to ${uuid}…`);
      const ad         = await this.homey.ble.find(uuid, 10000);
      this._peripheral = await ad.connect();

      this._peripheral.once('disconnect', () => {
        this.log('BLE disconnected');
        this._peripheral = null;
        this._notifyChar = null;
        this.setUnavailable('Disconnected from device').catch(this.error);
      });

      await this._subscribe();
      await this.setAvailable();
      this.log('Connected and subscribed to notifications');
    } catch (err) {
      this.error(`Connect failed: ${err.message}`);
      this._peripheral = null;
    }
  }

  async _subscribe() {
    const service = await this._peripheral.getService(protocol.SERVICE_UUID);
    const chars   = await service.discoverCharacteristics([protocol.NOTIFY_UUID]);
    if (!chars.length) throw new Error('Notify characteristic not found');
    this._notifyChar = chars[0];
    await this._notifyChar.subscribeToNotifications(data => this._onNotify(data));
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

  // ── Notification dispatch ─────────────────────────────────────────────────

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
      default:
        this.log(`Unknown packet: ${packet.type}`);
    }
  }

  // ── Packet handlers ───────────────────────────────────────────────────────

  _onStatus(p) {
    this._deviceStatus = p;
    this.setCapabilityValue('measure_battery', p.battery).catch(this.error);
    this.setSettings({
      firmware_version: p.version,
      probe_count:      String(p.probeCount),
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
            this.setCapabilityValue('alarm_generic.probe_disconnected', false).catch(this.error);
          }
        }
      } else {
        if (!this._disconnectedSet.has(i)) {
          this._disconnectedSet.add(i);
          this.setCapabilityValue('alarm_generic.probe_disconnected', true).catch(this.error);
          this._trgDisconnected
            .trigger(this, { probe: i + 1 }, {})
            .catch(this.error);
        }
      }
    }

    // Ambient channel
    if (hasAmbient && p.channels.length > probeCount) {
      const ambient = p.channels[probeCount];
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
    switch (p.message) {
      case 'above_max':
      case 'below_min':
        this.setCapabilityValue(`alarm_generic.${name}`, true).catch(this.error);
        break;
    }
  }

  _onAlarmDetail(p) {
    const names = ['probe1', 'probe2', 'probe3', 'probe4'];
    const name  = names[p.probe] ?? `probe${p.probe + 1}`;
    if (p.alarmType === 1) {
      this.setCapabilityValue(`alarm_generic.${name}`, true).catch(this.error);
      this._trgReachedTarget
        .trigger(this, { probe: p.probe + 1 }, {})
        .catch(this.error);
    }
  }

  // ── Write helpers ─────────────────────────────────────────────────────────

  async _write(buf) {
    if (!this._peripheral) throw new Error('Device not connected');
    this.log(`→ ${buf.toString('hex')}`);
    await this._peripheral.write(protocol.SERVICE_UUID, protocol.WRITE_UUID, buf);
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

  // Public API for flow action cards in driver.js
  async setTarget(probeIdx, tempC)     { return this._setTarget(probeIdx, tempC); }
  async setTimer(probeIdx, seconds)    { return this._setTimer(probeIdx, seconds); }
  async setRange(probeIdx, minC, maxC) { return this._write(protocol.encodeRange(probeIdx, minC, maxC)); }

}

module.exports = ToGrillDevice;
