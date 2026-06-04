'use strict';

const Homey = require('homey');
const { NAME_FILTER } = require('../../lib/togrill-protocol');

class ToGrillDriver extends Homey.Driver {

  async onInit() {
    this.log('ToGrillDriver initialized');

    this.homey.flow.getActionCard('set_target_temperature')
      .registerRunListener(async ({ device, probe, temperature }) => {
        this.log(`[flow] set_target_temperature → ${device.getName()} probe=${probe} temp=${temperature}`);
        await device.setTarget(Number(probe) - 1, temperature);
      });

    this.homey.flow.getActionCard('set_probe_timer')
      .registerRunListener(async ({ device, probe, seconds }) => {
        this.log(`[flow] set_probe_timer → ${device.getName()} probe=${probe} seconds=${seconds}`);
        await device.setTimer(Number(probe) - 1, seconds);
      });

    this.homey.flow.getActionCard('set_probe_range')
      .registerRunListener(async ({ device, probe, min_temp, max_temp }) => {
        this.log(`[flow] set_probe_range → ${device.getName()} probe=${probe} min=${min_temp} max=${max_temp}`);
        await device.setRange(Number(probe) - 1, min_temp, max_temp);
      });

    this.homey.flow.getActionCard('set_grill_type')
      .registerRunListener(async ({ device, probe, grill_type }) => {
        this.log(`[flow] set_grill_type → ${device.getName()} probe=${probe} type=${grill_type}`);
        await device.setGrillType(Number(probe) - 1, grill_type);
      });

    this.homey.flow.getActionCard('set_taste')
      .registerRunListener(async ({ device, probe, taste }) => {
        this.log(`[flow] set_taste → ${device.getName()} probe=${probe} taste=${taste}`);
        await device.setTaste(Number(probe) - 1, taste);
      });

    this.homey.flow.getConditionCard('probe_temp_above')
      .registerRunListener(async ({ device, probe, temperature }) => {
        const capId = probe === 'ambient'
          ? 'measure_temperature.ambient'
          : `measure_temperature.probe${probe}`;
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
