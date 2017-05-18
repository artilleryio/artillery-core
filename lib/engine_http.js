/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const _ = require('lodash');
const request = require('request');

const debug = require('debug')('http');
const debugResponse = require('debug')('http:response');
const debugFullBody = require('debug')('http:full_body');
const VERSION = require('../package.json').version;
const USER_AGENT = 'artillery ' + VERSION + ' (https://artillery.io)';
const engineUtil = require('./engine_util');
const template = engineUtil.template;
const http = require('http');
const https = require('https');
const fs = require('fs');
const filtrex = require('filtrex');

module.exports = HttpEngine;

function HttpEngine(script) {
  this.config = script.config;

  if (script.config.http && script.config.http.pool) {
    this.pool = {
      maxSockets: Number(script.config.http.pool)
    };
  }
}

HttpEngine.prototype.createScenario = function(scenarioSpec, ee) {
  var self = this;

  // Helper function to wrap an object's property in a list if it's
  // defined, or set it to an empty list if not.
  function ensurePropertyIsAList(obj, prop) {
    obj[prop] = [].concat(
      typeof obj[prop] === 'undefined' ?
        [] : obj[prop]);
    return obj;
  }

  ensurePropertyIsAList(scenarioSpec, 'beforeRequest');
  ensurePropertyIsAList(scenarioSpec, 'afterResponse');
  ensurePropertyIsAList(scenarioSpec, 'beforeScenario');
  ensurePropertyIsAList(scenarioSpec, 'afterScenario');

  // Add scenario-level hooks if needed:
  // For now, just turn them into function steps and insert them
  // directly into the flow array.
  // TODO: Scenario-level hooks will probably want access to the
  // entire scenario spec rather than just the userContext.
  const beforeScenarioFns = _.map(
    scenarioSpec.beforeScenario,
    function(hookFunctionName) {
      return {'function': hookFunctionName};
    });
  const afterScenarioFns = _.map(
    scenarioSpec.afterScenario,
    function(hookFunctionName) {
      return {'function': hookFunctionName};
    });

  const newFlow = beforeScenarioFns.concat(
    scenarioSpec.flow.concat(afterScenarioFns));

  scenarioSpec.flow = newFlow;

  let tasks = _.map(scenarioSpec.flow, function(rs) {
    return self.step(rs, ee, {
      beforeRequest: scenarioSpec.beforeRequest,
      afterResponse: scenarioSpec.afterResponse
    });
  });

  return self.compile(tasks, scenarioSpec.flow, ee);
};

HttpEngine.prototype.step = function step(requestSpec, ee, opts) {

  opts = opts || {};
  let self = this;
  let config = this.config;

  if (requestSpec.loop) {
    let steps = _.map(requestSpec.loop, function(rs) {
      return self.step(rs, ee, opts);
    });

    return engineUtil.createLoopWithCount(
      requestSpec.count || -1,
      steps,
      { loopValue: requestSpec.loopValue || '$loopCount' });
  }

  if (requestSpec.think) {
    return engineUtil.createThink(requestSpec, _.get(self.config, 'defaults.think', {}));
  }

  if (requestSpec.log) {
    return function(context, callback) {
      console.log(template(requestSpec.log, context));
      return process.nextTick(function() { callback(null, context); });
    };
  }

  if (requestSpec.function) {
    return function(context, callback) {
      let processFunc = self.config.processor[requestSpec.function];
      if (processFunc) {
        return processFunc(context, ee, function() {
          return callback(null, context);
        });
      } else {
        return process.nextTick(function () { callback(null, context); });
      }
    };
  }

  let f = function(context, callback) {
    let method = _.keys(requestSpec)[0].toUpperCase();
    let params = requestSpec[method.toLowerCase()];

    // A special case for when "url" attribute is missing. We need to check for
    // it manually as request.js won't emit an 'error' event when the argument
    // is missing.
    // This will be obsoleted by better script validation.
    if (!params.url && !params.uri) {
      let err = new Error('an URL must be specified');
      ee.emit('error', err.message);
      return callback(err, context);
    }

    let tls = config.tls || {};
    let timeout = config.timeout || _.get(config, 'http.timeout') || 120;

    if (!engineUtil.isProbableEnough(params)) {
      return process.nextTick(function() {
        callback(null, context);
      });
    }

    if (!_.isUndefined(params.ifTrue)) {
      let cond;
      let result;
      try {
        cond = filtrex(params.ifTrue);
        result = cond(context.vars);
      } catch (e) {
        result = 1; // if the expression is incorrect, just proceed // TODO: debug message
      }
      if (typeof result === 'undefined' || result === 0) {
        return process.nextTick(function () {
          callback(null, context);
        });
      }
    }

    // Run beforeRequest processors (scenario-level ones too)
    let requestParams = _.cloneDeep(params);
    requestParams = _.extend(requestParams, {
      url: maybePrependBase(params.url || params.uri, config), // *NOT* templating here
      method: method,
      headers: {
      },
      timeout: timeout * 1000,
      jar: context._jar
    });
    requestParams = _.extend(requestParams, tls);

    let functionNames = _.concat(opts.beforeRequest || [], params.beforeRequest || []);

    async.eachSeries(
      functionNames,
      function iteratee(functionName, next) {

        let processFunc = config.processor[functionName];
        processFunc(requestParams, context, ee, function(err) {
          if (err) {
            return next(err);
          }
          return next(null);
        });
      },
      function done(err) {
        if (err) {
          debug(err);
          let errCode = err.code || err.message;
          // FIXME: Should not need to have to emit manually here
          ee.emit('error', errCode);
          return callback(err, context);
        }

        // Assemble the new request params
        if (params.json) {
          requestParams.json = template(params.json, context);
        }

        if (params.body) {
          requestParams.body = template(params.body, context);
        }

        if (params.form) {
          requestParams.form = _.reduce(
            requestParams.form,
            function (acc, v, k) {
              acc[k] = template(v, context);
              return acc;
            },
            {});
        }

        // Assign default headers then overwrite as needed
        let defaultHeaders = lowcaseKeys(
          (config.defaults && config.defaults.headers) ?
            config.defaults.headers : {'user-agent': USER_AGENT});
        requestParams.headers = _.extend(defaultHeaders,
                                         lowcaseKeys(params.headers), lowcaseKeys(requestParams.headers));
        let headers = _.reduce(requestParams.headers,
                               function(acc, v, k) {
                                 acc[k] = template(v, context);
                                 return acc;
                               }, {});
        requestParams.headers = headers;

        let defaultCookie = config.defaults ? config.defaults.cookie || {} : {};

        let cookie = _.reduce(
          params.cookie,
          function(acc, v, k) {
            acc[k] = v;
            return acc;
          },
          defaultCookie);

        if (cookie) {
          _.each(cookie, function(v, k) {
            context._jar.setCookie(k + '=' + template(v, context), requestParams.url);
          });
        }

        if (typeof requestParams.auth === 'object') {
          requestParams.auth.user = template(requestParams.auth.user, context);
          requestParams.auth.pass = template(requestParams.auth.pass, context);
        }

        if (config.http2) {
          requestParams.http2 = true;
        } else {
          if (!self.pool) {
            requestParams.agent = context._agent;
          } else {

            requestParams.pool = self.pool;
          }
        }

        let url = maybePrependBase(template(requestParams.uri || requestParams.url, context), config);

        if (requestParams.uri) {
          // If a hook function sets requestParams.uri to something, request.js
          // will pick that over .url, so we need to delete it.
          delete requestParams.uri;
        }

        requestParams.url = url;

        function requestCallback(err, res, body) {
          if (err) {
            return;
          }

          if (process.env.DEBUG) {
            let requestInfo = {
              url: requestParams.url,
              method: requestParams.method,
              headers: requestParams.headers
            };
            if (requestParams.json && typeof requestParams.json !== 'boolean') {
              requestInfo.json = requestParams.json;
            }

            // If "json" is set to an object, it will be serialised and sent as body and the value of the "body" attribute will be ignored.
            if (requestParams.body && typeof requestParams.json !== 'object') {
              if (process.env.DEBUG.indexOf('http:full_body') > -1) {
                // Show the entire body
                requestInfo.body = requestParams.body;
              } else {
                // Only show the beginning of long bodies
                requestInfo.body = requestParams.body.substring(0, 512);
                if (requestParams.body.length > 512) {
                  requestInfo.body += ' ...';
                }
              }
            }
            debug('request: %s', JSON.stringify(requestInfo, null, 2));
          }

          debugResponse(JSON.stringify(res.headers, null, 2));
          debugResponse(JSON.stringify(body, null, 2));

          engineUtil.captureOrMatch(
            params,
            res,
            context,
            function captured(err, result) {
              if (err) {
                // end the scenario
                ee.emit('error', err.message);
                return callback(err, context);
              }

              debug('captures and matches:');
              debug(result.matches);
              debug(result.captures);

              // match and capture are strict by default:
              let haveFailedMatches = _.some(result.matches, function(v, k) {
                return !v.success && v.strict !== false;
              });

              let haveFailedCaptures = _.some(result.captures, function(v, k) {
                return v === '';
              });

              if (haveFailedMatches || haveFailedCaptures) {
                // TODO: Emit the details of each failed capture/match
              } else {
                _.each(result.matches, function(v, k) {
                  ee.emit('match', v.success, {
                    expected: v.expected,
                    got: v.got,
                    expression: v.expression,
                    strict: v.strict
                  });
                });

                _.each(result.captures, function(v, k) {
                  context.vars[k] = v;
                });
              }

              // Now run afterResponse processors
              let functionNames = _.concat(opts.afterResponse || [], params.afterResponse || []);
              async.eachSeries(
                functionNames,
                function iteratee(functionName, next) {
                  let processFunc = config.processor[functionName];
                  processFunc(requestParams, res, context, ee, function(err) {
                    if (err) {
                      return next(err);
                    }
                    return next(null);
                  });
                }, function(err) {
                  if (err) {
                    debug(err);
                    ee.emit('error', err.code || err.message);
                    return callback(err, context);
                  }

                  if (haveFailedMatches || haveFailedCaptures) {
                    // FIXME: This means only one error in the report even if multiple captures failed for the same request.
                    return callback(new Error('Failed capture or match'), context);
                  }

                  return callback(null, context);
                });
            });
        }

        // If we aren't processing the full response, we don't need the
        // callback:
        let maybeCallback;
        if (typeof requestParams.capture === 'object' ||
            typeof requestParams.match === 'object' ||
            requestParams.afterResponse ||
            opts.afterResponse ||
            process.env.DEBUG) {
          maybeCallback = requestCallback;
        }

        if(!requestParams.url) {
          let err = new Error('an URL must be specified');
          ee.emit('error', err.message);
          return callback(err, context);
        }

        request(requestParams, maybeCallback)
          .on('request', function(req) {
            ee.emit('request');

            const startedAt = process.hrtime();

            req.on('response', function updateLatency(res) {
              let code = res.statusCode;
              const endedAt = process.hrtime(startedAt);
              let delta = (endedAt[0] * 1e9) + endedAt[1];
              ee.emit('response', delta, code, context._uid);
            });
          }).on('end', function() {
            context._successCount++;

            if (!maybeCallback) {
              callback(null, context);
            } // otherwise called from requestCallback
          }).on('error', function(err) {
            let errCode = err.code || err.message;
            ee.emit('error', errCode);
            debug(err);
            // this aborts the scenario
            return callback(err, context);
          });
      }); // eachSeries
  };

  return f;
};

HttpEngine.prototype.compile = function compile(tasks, scenarioSpec, ee) {
  let self = this;
  let config = this.config;
  let tls = config.tls || {};

  return function scenario(initialContext, callback) {
    initialContext._successCount = 0;

    initialContext._jar = request.jar();

    if (!config.http2) {
      if (!self.pool) {
        let agentOpts = {
          keepAlive: true,
          keepAliveMsecs: 1000,
          maxSockets: 1,
          maxFreeSockets: 1
        };

        // FIXME: This won't work if we have a pool - needs to be set in agentOptions
        // in request params
        if ((/^https/i).test(config.target)) {
          if (tls.pfx) {
            // FIXME: Path needs to be resolved relative to Artillery's cwd
            agentOpts.pfx = fs.readFileSync(tls.pfx);
          }
          initialContext._agent = new https.Agent(agentOpts);
        } else {
          initialContext._agent = new http.Agent(agentOpts);
        }
      }
    }

    let steps = _.flatten([
      function zero(cb) {
        ee.emit('started');
        return cb(null, initialContext);
      },
      tasks
    ]);

    async.waterfall(
      steps,
      function scenarioWaterfallCb(err, context) {
        // If the connection was refused we might not have a context
        if (context && context._agent) {
          context._agent.destroy();
        }

        if (err) {
          ee.emit('error', err.message);
          return callback(err, context);
        } else {
          return callback(null, context);
        }
      });
  };
};

function maybePrependBase(uri, config) {
  if (_.startsWith(uri, '/')) {
    return config.target + uri;
  } else {
    return uri;
  }
}

/*
 * Given a dictionary, return a dictionary with all keys lowercased.
 */
function lowcaseKeys(h) {
  return _.transform(h, function(result, v, k) {
    result[k.toLowerCase()] = v;
  });
}
