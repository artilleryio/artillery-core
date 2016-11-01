'use strict';

const test = require('tape');
const runner = require('../lib/runner').runner;

test('Plugin package name inside plugin config', function(t) {
    runTest(t, './scripts/plugin_packaged_inner.json');
});

test('Plugin package name outside plugin config', function(t) {
    runTest(t, './scripts/plugin_packaged_outer.json');
});

test('Plugin package name inside plugin config overriding outter package name', function(t) {
    runTest(t, './scripts/plugin_packaged_inner_override_outter.json');
});

test('Normal artillery-plugin-*', function(t) {
    runTest(t, './scripts/artillery_plugin.json');
});

function runTest(t, scriptName){
    const script = require(scriptName);
    const ee = runner(script);

    ee.on('plugin_loaded', function(stats){
      t.assert(true);
      t.end();
    });

    ee.run();
}
