/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const assert = require('assert');

function advancedPlugin(config, ee) {

  ee.on('init', function(script, options) {
    assert(script.config.plugins.someAdvancedPlugin.foo === 'bar');
    script.config.variables.advanced = 'hello';
  });

  ee.on('done', function(stats){
    ee.emit('plugin_loaded', stats);
  });
  return this;
}

module.exports = advancedPlugin;
