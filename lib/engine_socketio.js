/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');
const io = require('socket.io-client');
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
      return engineUtil.createThink(rs);
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

function processResponse(ee, data, expectedData) {
  let err = null;

  if (expectedData && (data !== expectedData)) {
    debug(data);
    err = 'data is not valid';
    ee.emit('error', err);
  }

  return err;
}


function connectSocket(context, callback, ee, requestSpec) {
  let config = this.config;
  let tls = config.tls || {};
  let target = config.target;
  let options = {};
  if (config.engines && config.engines.socketio && config.engines.socketio.path) {
    options.path = config.engines && config.engines.socketio && config.engines.socketio.path;
  }
  options = _.extend(options, tls);

  let socketio = io.connect(target, options);
  socketio.on('connect', function() {
    console.log("socket is connected.");
    if (requestSpec.params && requestSpec.params.token) {
      console.log("socket is going to authenticate.");
      socketio.emit('authenticate', { token: context.vars.authToken });
    }
    ee.emit('started');
    return callback(null, _.extend({socketio: socketio}, context));
  });
  socketio.on('authenticated', function () {
    console.log("socket is authenticated.");
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
      return engineUtil.createThink(requestSpec);
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
      channel: template(requestSpec.emit.channel, context),
      data: template(requestSpec.emit.data, context)
    };

    if (isResponseRequired(requestSpec)) {
      let response = {
        channel: template(requestSpec.emit.response.channel, context),
        data: template(requestSpec.emit.response.data, context)
      };
      // Listen for the socket.io response on the specified channel
      let done = false;
      context.socketio.on(response.channel, function receive(data) {
        done = true;
        let err = processResponse(ee, data, response.data);
        if (!err) {
          markEndTime(ee, context, startedAt);
        }
        // Stop listening on the response channel
        context.socketio.off(response.channel);
        return callback(err, context);
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
        if (context.socketio) {
          context.socketio.disconnect();
        }
        return callback(err, context);
      });
  };
};
