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

test('Advanced artillery-plugin-*', function(t) {
  var pluginScript = require('./scripts/advanced_plugin.json');

  pluginScript.config.processor = {
    "expectHello": function(req, context, ee, next) {
      t.assert(context.vars.advanced === 'hello');
      return next();
    }
  };

  runTest(t, pluginScript);
});

function runTest(t, scriptRef){

  const script = (typeof scriptRef === 'string') ? require(scriptRef) : scriptRef;
  const ee = runner(script);

  ee.on('plugin_loaded', function(stats){
    t.assert(true);
    t.end();
  });

  ee.run();
}
