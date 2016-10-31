'use strict';

const test = require('tape');
const runner = require('../lib/runner').runner;

test('config variables', function(t) {
    const script = require('./scripts/plugin_packaged.json');
    const ee = runner(script);

    ee.on('packaged_plugin_loaded', function(stats){
      t.assert(true);
      t.end();
    });

    ee.run();
});
