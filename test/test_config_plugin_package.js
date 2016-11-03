/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

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
