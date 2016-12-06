/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');
const io = require('socket.io-client');
const deepEqual = require('deep-equal');
const debug = require('debug')('socketio');
const engineUtil = require('./engine_util');
const EngineHttp = require('./engine_http');
const template = engineUtil.template;
module.exports = SocketIoEngine;

function SocketIoEngine(script) {
  this.config = script.config;
  this.httpDelegate = new EngineHttp(script);
}

SocketIoEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;
  let tasks = _.map(scenarioSpec.flow, function(rs) {
    if (rs.think) {
      return engineUtil.createThink(rs, _.get(self.config, 'defaults.think', {}));
    }
    return self.step(rs, ee);
  });

  return self.compile(tasks, scenarioSpec, ee);
};

function markEndTime(ee, context, startedAt) {
  let endedAt = process.hrtime(startedAt);
  let delta = (endedAt[0] * 1e9) + endedAt[1];
  ee.emit('response', delta, 0, context._uid);
}

function isResponseRequired(spec) {
  return (spec.emit && spec.emit.response && spec.emit.response.channel);
}

function processResponse(ee, data, response, context, callback) {
  // Do we have supplied data to validate?
  if (response.data && !deepEqual(data, response.data)) {
    debug(data);
    let err = 'data is not valid';
    ee.emit('error', err);
    return callback(err, context);
  }

  // If no capture or match specified, then we consider it a success at this point...
  if (!response.capture && !response.match) {
    return callback(null, context);
  }

  // Construct the (HTTP) response...
  let fauxResponse = {body: JSON.stringify(data)};

  // Handle the capture or match clauses...
  engineUtil.captureOrMatch(response, fauxResponse, context, function(err, result) {
    // Were we unable to invoke captureOrMatch?
    if (err) {
      debug(data);
      ee.emit('error', err);
      return callback(err, context);
    }

    // Do we have any failed matches?
    let haveFailedMatches = _.some(result.matches, function(v, k) {
      return !v.success;
    });

    // How to handle failed matches?
    if (haveFailedMatches) {
      // TODO: Should log the details of the match somewhere
      ee.emit('error', 'Failed match');
      return callback(new Error('Failed match'), context);
    } else {
      // Emit match events...
      _.each(result.matches, function(v, k) {
        ee.emit('match', v.success, {
          expected: v.expected,
          got: v.got,
          expression: v.expression
        });
      });

      // Populate the context with captured values
      _.each(result.captures, function(v, k) {
        context.vars[k] = v;
      });

      // Replace the base object context
      // Question: Should this be JSON object or String?
      context.vars.$ = fauxResponse.body;

      // Increment the success count...
      context._successCount++;

      return callback(null, context);
    }
  });
}

function onConnectSocketDone(context, callback, ee, socketio) {
    ee.emit('started');
    return callback(null, _.extend({socketio: socketio}, context));
}

function connectSocket(context, callback, ee, requestSpec) {
  let config = this.config;
  let tls = config.tls || {};
  let target = config.target;
  let options = {};
  if (config.engines && config.engines.socketio && config.engines.socketio.namespace) {
    target += config.engines.socketio.namespace;
  }
  if (config.engines && config.engines.socketio && config.engines.socketio.path) {
    options.path = config.engines && config.engines.socketio && config.engines.socketio.path;
  }
  options = _.extend(options, tls);

  let socketio = io(target, options);
  socketio.on('connect', function() {
    debug('socket is connected');
    if (requestSpec.params && requestSpec.params.token) {
      let token = context.vars[requestSpec.params.token] || requestSpec.params.token;
      socketio.emit('authenticate', { token: token });
    } else {
      onConnectSocketDone(context, callback, ee, socketio);
    }
  });
  socketio.on('authenticated', function () {
    debug('socket is authenticated');
    onConnectSocketDone(context, callback, ee, socketio);
  });

  socketio.on('connect_error', function(err) {
    debug(err);
    ee.emit('error', err.message);
    return callback(err, {});
  });
}

SocketIoEngine.prototype.connectSocketStep = function (requestSpec, ee) {
  let self = this;

  let f = function (context, callback) {
    connectSocket.apply(self, [context, callback, ee, requestSpec.connectsocket]);
  };
  return f;
};

function buildJsonData(data, jsonData, context) {
  for (var key in jsonData) {
    if (jsonData.hasOwnProperty(key)) {
      var val = jsonData[key];
      if (typeof val === 'string') {
        data[key] = context.vars[val] || val;
      } else if (typeof val === 'object') {
        if (Array.isArray(val)) {
          data[key] = val.map(function (json) {
            return buildJsonData({}, json, context);
          });
        } else {
          data[key] = buildJsonData({}, val, context);
        }
      }
    }
  }
  return data;
}

SocketIoEngine.prototype.step = function (requestSpec, ee) {
  let self = this;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      if (!rs.emit) {
        return self.httpDelegate.step(rs, ee);
      }
      return self.step(rs, ee);
    });

    return engineUtil.createLoopWithCount(requestSpec.count || -1, steps);
  }

  let f = function(context, callback) {
    // Only process emit requests; delegate the rest to the HTTP engine (or think utility)
    if (requestSpec.think) {
      return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
    }
    if (requestSpec.connectsocket) {
      let delegateFunc = self.connectSocketStep(requestSpec, ee);
      return delegateFunc(context, callback);
    }
    if (!requestSpec.emit) {
      let delegateFunc = self.httpDelegate.step(requestSpec, ee);
      return delegateFunc(context, callback);
    }
    ee.emit('request');
    let startedAt = process.hrtime();

    if (!(requestSpec.emit && requestSpec.emit.channel)) {
      ee.emit('error', 'invalid arguments');
    }

    let outgoing = {
      channel: template(requestSpec.emit.channel, context)
    };

    if (requestSpec.emit.jsonData) {
      outgoing.data = buildJsonData({}, requestSpec.emit.jsonData, context);
    } else {
      outgoing.data = template(requestSpec.emit.data, context);
    }

    debug('socket emits ' + requestSpec.emit.channel);
    if (isResponseRequired(requestSpec)) {
      let response = {
        channel: template(requestSpec.emit.response.channel, context),
        data: template(requestSpec.emit.response.data, context),
        capture: template(requestSpec.emit.response.capture, context),
        match: template(requestSpec.emit.response.match, context)
      };
      // Listen for the socket.io response on the specified channel
      let done = false;
      context.socketio.on(response.channel, function receive(data) {
        done = true;
        processResponse(ee, data, response, context, function(err) {
          if (!err) {
            markEndTime(ee, context, startedAt);
          }
          // Stop listening on the response channel
          context.socketio.off(response.channel);
          return callback(err, context);
        });
      });
      // Send the data on the specified socket.io channel
      context.socketio.emit(outgoing.channel, outgoing.data);
      // If we don't get a response within the timeout, fire an error
      let waitTime = self.config.timeout || 10;
      waitTime *= 1000;
      setTimeout(function responseTimeout() {
        if (!done) {
          let err = 'response timeout';
          ee.emit('error', err);
          return callback(err, context);
        }
      }, waitTime);
    } else {
      // No return data is expected, so emit without a listener
      context.socketio.emit(outgoing.channel, outgoing.data);
      markEndTime(ee, context, startedAt);
      return callback(null, context);
    }
  };

  return f;
};

SocketIoEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let config = this.config,
      self = this;

  return function scenario(initialContext, callback) {
    initialContext._successCount = 0;
    initialContext._pendingRequests = _.size(
      _.reject(scenarioSpec.flow, function(rs) {
        return (typeof rs.think === 'number');
      }));

    let _tasks = [];
    if (scenarioSpec.socketconnect === 'manual') {
      _tasks.push(function (cb) {
        return (function () {
          return cb(null, initialContext);
        })();
      });
    } else {
      _tasks.push(function (cb) {
        return connectSocket.call(self, initialContext, cb, ee);
      });
    }

    _tasks.push(tasks);
    let steps = _.flatten(_tasks);

    async.waterfall(
      steps,
      function scenarioWaterfallCb(err, context) {
        if (err) {
          debug(err);
        }
        if (context && context.socketio) {
          context.socketio.disconnect();
        }
        return callback(err, context);
      });
  };
};
