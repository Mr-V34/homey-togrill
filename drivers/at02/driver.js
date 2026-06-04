'use strict';

const Homey = require('homey');
const { NAME_FILTER } = require('../../lib/togrill-protocol');

class ToGrillDriver extends Homey.Driver {

  async onInit() {
    this.log('ToGrillDriver initialized');

    // Probe selectors are dynamic: only probes currently reporting a temperature
    // are offered (disconnected probes are hidden). includeAmbient adds the grill.
    const probeAutocomplete = (includeAmbient = false) => async (query, args) => {
      const list = args.device ? args.device.getProbeChoices(includeAmbient) : [];
      const q = (query || '').toLowerCase();
      return list.filter(o => o.name.toLowerCase().includes(q));
    };

    const setTarget = this.homey.flow.getActionCard('set_target_temperature');
    setTarget.registerArgumentAutocompleteListener('probe', probeAutocomplete());
    setTarget.registerRunListener(async ({ device, probe, temperature }) => {
      this.log(`[flow] set_target_temperature → ${device.getName()} probe=${probe.id} temp=${temperature}`);
      await device.setTarget(Number(probe.id) - 1, temperature);
    });

    const setTimer = this.homey.flow.getActionCard('set_probe_timer');
    setTimer.registerArgumentAutocompleteListener('probe', probeAutocomplete());
    setTimer.registerRunListener(async ({ device, probe, seconds }) => {
      this.log(`[flow] set_probe_timer → ${device.getName()} probe=${probe.id} seconds=${seconds}`);
      await device.setTimer(Number(probe.id) - 1, seconds);
    });

    const setRange = this.homey.flow.getActionCard('set_probe_range');
    setRange.registerArgumentAutocompleteListener('probe', probeAutocomplete());
    setRange.registerRunListener(async ({ device, probe, min_temp, max_temp }) => {
      this.log(`[flow] set_probe_range → ${device.getName()} probe=${probe.id} min=${min_temp} max=${max_temp}`);
      await device.setRange(Number(probe.id) - 1, min_temp, max_temp);
    });

    const setGrillType = this.homey.flow.getActionCard('set_grill_type');
    setGrillType.registerArgumentAutocompleteListener('probe', probeAutocomplete());
    setGrillType.registerRunListener(async ({ device, probe, grill_type }) => {
      this.log(`[flow] set_grill_type → ${device.getName()} probe=${probe.id} type=${grill_type}`);
      await device.setGrillType(Number(probe.id) - 1, grill_type);
    });

    const setTaste = this.homey.flow.getActionCard('set_taste');
    setTaste.registerArgumentAutocompleteListener('probe', probeAutocomplete());
    setTaste.registerRunListener(async ({ device, probe, taste }) => {
      this.log(`[flow] set_taste → ${device.getName()} probe=${probe.id} taste=${taste}`);
      await device.setTaste(Number(probe.id) - 1, taste);
    });

    const tempAbove = this.homey.flow.getConditionCard('probe_temp_above');
    tempAbove.registerArgumentAutocompleteListener('probe', probeAutocomplete(true));
    tempAbove.registerRunListener(async ({ device, probe, temperature }) => {
      const capId = probe.id === 'ambient'
        ? 'measure_temperature.ambient'
        : `measure_temperature.probe${probe.id}`;
      const current = device.getCapabilityValue(capId);
      if (current === null || current === undefined) return false;
      return current > temperature;
    });
  }

  async onPair(session) {
    session.setHandler('list_devices', async () => {
      this.log('BLE scan started (10 s)…');
      const advertisements = await this.homey.ble.discover([], 10000);

      const found = advertisements.filter(ad =>
        ad.localName && NAME_FILTER.some(n => ad.localName.includes(n))
      );
      this.log(`Found ${found.length} ToGrill device(s)`);

      return found.map(ad => ({
        name:  String(ad.localName || 'ToGrill AT-02').slice(0, 64).replace(/[<>&"']/g, ''),
        data:  { id: ad.uuid },
        store: { peripheralUuid: ad.uuid },
      }));
    });
  }

}

module.exports = ToGrillDriver;
