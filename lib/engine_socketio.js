/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');

const request = require('request');
const io = require('socket.io-client');
const wildcardPatch = require('socketio-wildcard')(io.Manager);

const deepEqual = require('deep-equal');
const debug = require('debug')('socketio');
const engineUtil = require('./engine_util');
const EngineHttp = require('./engine_http');
const template = engineUtil.template;
module.exports = SocketIoEngine;

function SocketIoEngine(script) {
  this.config = script.config;

  if (script.config.socketio) {
    if (script.config.socketio.transports) {
      this.transports = {
        transports: script.config.socketio.transports
      };
    }

    if (script.config.socketio.query) {
      this.query = {
        query: script.config.socketio.query
      };
    }

	if (script.config.socketio.path) {
      this.path = {
        path: script.config.socketio.path
      };
    }
  }

  this.httpDelegate = new EngineHttp(script);
}

SocketIoEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;
  var socketHeaders = scenarioSpec.socketHeaders || {};
  let tasks = _.map(scenarioSpec.flow, function(rs) {
    if (rs.think) {
      return engineUtil.createThink(rs, _.get(self.config, 'defaults.think', {}));
    }
    return self.step(rs, socketHeaders, ee);
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

function markEndTime(ee, context, startedAt) {
  let endedAt = process.hrtime(startedAt);
  let delta = (endedAt[0] * 1e9) + endedAt[1];
  ee.emit('response', delta, 0, context._uid);
}

function isResponseRequired(spec) {
  return (spec.emit && spec.emit.response && spec.emit.response.channel);
}

function isAcknowledgeRequired(spec) {
    return (spec.emit && spec.emit.acknowledge);
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

SocketIoEngine.prototype.step = function (requestSpec, socketHeaders, ee) {
  let self = this;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      if (!rs.emit) {
        return self.httpDelegate.step(rs, ee);
      }
      return self.step(rs, socketHeaders, ee);
    });

    return engineUtil.createLoopWithCount(
      requestSpec.count || -1,
      steps,
      {
        loopValue: requestSpec.loopValue,
        overValues: requestSpec.over
      }
    );
  }

  let f = function(context, callback) {
    // Only process emit requests; delegate the rest to the HTTP engine (or think utility)
    if (requestSpec.think) {
      return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
    }
    if (!requestSpec.emit) {
      let delegateFunc = self.httpDelegate.step(requestSpec, ee);
      return delegateFunc(context, callback);
    }
    ee.emit('request');
    let startedAt = process.hrtime();
    let socketio = context.sockets[requestSpec.emit.namespace] || null;

    if (!(requestSpec.emit && requestSpec.emit.channel && socketio)) {
      return ee.emit('error', 'invalid arguments');
    }

    let outgoing = {
      channel: template(requestSpec.emit.channel, context),
      data: template(requestSpec.emit.data, context)
    };

    let endCallback = function (err, context) {
      if (err) {
        debug(err);
      }

      if (isAcknowledgeRequired(requestSpec)) {
        // Acknowledge required so add callback to emit
        socketio.emit(outgoing.channel, outgoing.data, function (data) {
          let response = {
            data: template(requestSpec.emit.acknowledge.data, context),
            capture: template(requestSpec.emit.acknowledge.capture, context),
            match: template(requestSpec.emit.acknowledge.match, context)
          };
          processResponse(ee, data, response, context, function (err) {
            if (!err) {
              markEndTime(ee, context, startedAt);
            }
            return callback(err, context);
          });
        });
      } else {
        // No acknowledge data is expected, so emit without a listener
        socketio.emit(outgoing.channel, outgoing.data);
        markEndTime(ee, context, startedAt);
        return callback(null, context);
      }
    };

    if (isResponseRequired(requestSpec)) {
      let response = {
        channel: template(requestSpec.emit.response.channel, context),
        data: template(requestSpec.emit.response.data, context),
        capture: template(requestSpec.emit.response.capture, context),
        match: template(requestSpec.emit.response.match, context)
      };
      // Listen for the socket.io response on the specified channel
      let done = false;
      socketio.on(response.channel, function receive(data) {
        done = true;
        processResponse(ee, data, response, context, function(err) {
          if (!err) {
            markEndTime(ee, context, startedAt);
          }
          // Stop listening on the response channel
          socketio.off(response.channel);
          return endCallback(err, context);
        });
      });
      // Send the data on the specified socket.io channel
      socketio.emit(outgoing.channel, outgoing.data);
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
      endCallback(null, context);
    }
  };

  function preStep(context, callback){
    // Set default namespace in emit action
    requestSpec.emit.namespace = template(requestSpec.emit.namespace, context) || "/";

    // Assign default headers then overwrite as needed
    let defaultHeaders = engineUtil.lowcaseKeys(
      (config.defaults && config.defaults.headers) ?
        config.defaults.headers : {'user-agent': USER_AGENT});
      
    let userHeaders = socketHeaders.headers || {};    
    let customHeaders = _.extend(defaultHeaders,
                                     engineUtil.lowcaseKeys(userHeaders));
    let headers = _.reduce(customHeaders,
                          function(acc, v, k) {
                            acc[k] = template(v, context);
                            return acc;
                          }, {});

    let userCookies = socketHeaders.cookie || {};
    let defaultCookie = config.defaults ? config.defaults.cookie || {} : {};
    let cookie = _.reduce(
      userCookies,
      function(acc, v, k) {
        acc[k] = v;
        return acc;
      },
      defaultCookie);

    if (cookie) {
      let cookies = [];
      _.each(cookie, function(v, k) {
        cookies.push(`${k}=${template(v, context)};`)
      });
      headers.Cookie = cookies.join(' ');
    }

    self.loadContextSocket(requestSpec.emit.namespace, headers, context, function(err, socket){
      if(err) {
        debug(err);
        ee.emit('error', err.message);
        return callback(err, context);
      }

      return f(context, callback);
    });
  }

  if(requestSpec.emit) {
    return preStep;
  } else {
    return f;
  }
};

SocketIoEngine.prototype.loadContextSocket = function(namespace, headers, context, cb) {
  context.sockets = context.sockets || {};

  if(!context.sockets[namespace]) {
    let target = this.config.target + namespace;
    let tls = this.config.tls || {};
    let transports = this.transports || {};
    let path = template(this.path || {}, context);
    let query = template(this.query || {}, context);
    let extraHeaders = { extraHeaders: headers };
    let options = _.extend(
      {},
      tls,
      transports,
      query,
      path,
      extraHeaders
    );

    let socket = io(target, options);
    context.sockets[namespace] = socket;
    wildcardPatch(socket);

    socket.on('*', function () {
      context.__receivedMessageCount++;
    });

    socket.once('connect', function() {
      cb(null, socket);
    });
    socket.once('connect_error', function(err) {
      cb(err, null);
    });
  } else {
    return cb(null, context.sockets[namespace]);
  }
};

SocketIoEngine.prototype.closeContextSockets = function (context) {
  // if(context.socketio) {
  //   context.socketio.disconnect();
  // }
  if(context.sockets && Object.keys(context.sockets).length > 0) {
    var namespaces = Object.keys(context.sockets);
    namespaces.forEach(function(namespace){
      context.sockets[namespace].disconnect();
    });
  }
};


SocketIoEngine.prototype.compile = function (tasks, scenarioSpec, ee) {
  let config = this.config;
  let self = this;

  function zero(callback, context) {
    context.__receivedMessageCount = 0;
    ee.emit('started');
    self.loadContextSocket('/', context, function done(err) {
      if (err) {
        ee.emit('error', err);
        return callback(err, context);
      }

      return callback(null, context);
    });
  }

  return function scenario(initialContext, callback) {
    initialContext._successCount = 0;
    initialContext._jar = request.jar();
    initialContext._pendingRequests = _.size(
        _.reject(scenarioSpec, function(rs) {
          return (typeof rs.think === 'number');
        }));

    let steps = _.flatten([
      function z(cb) {
        return zero(cb, initialContext);
      },
      tasks
    ]);

    async.waterfall(
        steps,
        function scenarioWaterfallCb(err, context) {
          if (err) {
            debug(err);
          }
          if (context) {
            self.closeContextSockets(context);
          }
          return callback(err, context);
        });
  };
};
