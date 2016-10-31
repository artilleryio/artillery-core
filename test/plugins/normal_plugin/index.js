'use strict';

function normalPlugin(config, ee) {
  ee.on('done', function(stats){
    ee.emit('packaged_plugin_loaded', stats);
  });
  return this;
}

module.exports = normalPlugin;
