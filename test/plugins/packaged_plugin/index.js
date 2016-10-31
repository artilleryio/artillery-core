'use strict';

function packagedPlugin(config, ee) {
  ee.on('done', function(stats){
    ee.emit('plugin_loaded', stats);
  });
  return this;
}

module.exports = packagedPlugin;
