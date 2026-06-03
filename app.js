'use strict';

const Homey = require('homey');

class ToGrillApp extends Homey.App {

  async onInit() {
    this.log('ToGrill app started');
    this.log(`Platform: ${this.homey.platform}`);
    this.log(`Homey:    ${this.homey.version}`);
  }

  async onUninit() {
    this.log('ToGrill app stopped');
  }

}

module.exports = ToGrillApp;
