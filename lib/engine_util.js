/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const async = require('async');
const debug = require('debug')('engine_util');
const hogan = require('hogan.js');
const traverse = require('traverse');
const esprima = require('esprima');
const L = require('lodash');
const vm = require('vm');
const A = require('async');
const jsonpath = require('JSONPath');
const cheerio = require('cheerio');

let xmlCapture;
try {
  xmlCapture = require('artillery-xml-capture');
} catch (e) {
  xmlCapture = null;
}

module.exports = {
  createThink: createThink,
  createLoopWithCount: createLoopWithCount,
  isProbableEnough: isProbableEnough,
  template: template,
  captureOrMatch,
  evil: evil
};

function createThink(requestSpec) {
  let thinkspec = requestSpec.think;

  let f = function(context, callback) {
    let thinktime = parseFloat(template(thinkspec, context)) * 1000;
    debug('think %s -> %s', requestSpec.think, thinktime);
    setTimeout(function() {
      callback(null, context);
    }, thinktime);
  };

  return f;
}

// "count" can be an integer (negative or positive) or a string defining a range
// like "1-15"
function createLoopWithCount(count, steps) {
  let from = parseLoopCount(count).from;
  let to = parseLoopCount(count).to;

  return function aLoop(context, callback) {
    let i = from;
    let newContext = context;
    newContext.vars.$loopCount = i;
    A.whilst(
      function test() {
        return i < to || to === -1;
      },
      function repeated(cb) {
        let zero = function(cb2) {
          return cb2(null, newContext);
        };
        let steps2 = L.flatten([zero, steps]);
        A.waterfall(steps2, function(err, context2) {
          i++;
          newContext = context2;
          newContext.vars.$loopCount++;
          return cb(err, context2);
        });
      },
      function(err, finalContext) {
        return callback(err, finalContext);
      });
  };
}

function isProbableEnough(obj) {
  if (typeof obj.probability === 'undefined') {
    return true;
  }

  let probability = Number(obj.probability) || 0;
  if (probability > 100) {
    probability = 100;
  }

  let r = L.random(100);
  return r < probability;
}

function template(o, context) {
  let result;
  if (typeof o === 'object') {
    result = traverse(o).map(function(x) {

      if (typeof x === 'string') {
        this.update(template(x, context));
      } else {
        return x;
      }
    });
  } else {
    if (!/{{/.test(o)) {
      return o;
    }
    const funcCallRegex = /{{\s*(\$[A-Za-z0-9_]+\s*\(\s*.*\s*\))\s*}}/;
    let match = o.match(funcCallRegex);
    if (match) {
      // This looks like it could be a function call:
      const syntax = esprima.parse(match[1]);
      // TODO: Use a proper schema for what we expect here
      if (syntax.body && syntax.body.length === 1 &&
          syntax.body[0].type === 'ExpressionStatement') {
        let funcName = syntax.body[0].expression.callee.name;
        let args = L.map(syntax.body[0].expression.arguments, function(arg) {
          return arg.value;
        });
        if (funcName in context.funcs) {
          return template(o.replace(funcCallRegex, context.funcs[funcName].apply(null, args)), context);
        }
      }
    } else {
      if (!o.match(/{{/)) {
        return o;
      }

      result = (hogan.compile(o)).render(context.vars);
    }
  }
  return result;
}

// Presume code is valid JS code (i.e. that it has been checked elsewhere)
function evil(sandbox, code) {
  let context = vm.createContext(sandbox);
  let script = new vm.Script(code);
  try {
    return script.runInContext(context);
  }
  catch(e) {
    return null;
  }
}


function parseLoopCount(countSpec) {
  let from = 0;
  let to = 0;

  if (typeof countSpec === 'number') {
    from = 0;
    to = countSpec;
  } else if (typeof countSpec === 'string') {
    if (isNaN(Number(countSpec))) {
      if (/\d\-\d/.test(countSpec)) {
        from = Number(countSpec.split('-')[0]);
        to = Number(countSpec.split('-')[1]);
      } else {
        to = 0;
      }
    } else {
      to = Number(countSpec);
    }
  } else {
    to = 0;
  }

  return { from: from, to: to };
}

//
// Calls done() with:
// {captures: { var: value }, matches: { var: {expected: '', got: ''} }}
//
function captureOrMatch(params, response, context, done) {
  let specs = L.concat(
    L.get(params, 'capture', []),
    L.get(params, 'match', []));

  let result = {
    captures: {},
    matches: {}
  };

  async.eachSeries(
    specs,
    function(spec, next) {
      let parsedSpec = parseSpec(spec, response);
      let parser = parsedSpec.parser;
      let extractor = parsedSpec.extractor;
      let expr = parsedSpec.expr;

      // are we looking at body or headers:
      var content = response.body;
      if (spec.header) {
        content = response.headers;
      }

      parser(content, function(err, doc) {
        if (err) {
          return next(err, null);
        }

        let extractedValue = extractor(doc, expr, spec);

        if (spec.value) {
          // this is a match spec
          let expected = template(spec.value, context);
          debug('match: %s, expected: %s, got: %s', expr, expected, extractedValue);
          if (extractedValue !== expected) {
            result.matches[expr] = {
              success: false,
              expected: expected,
              got: extractedValue,
              expression: expr,
              strict: spec.strict
            };
          } else {
            result.matches.expr = {
              success: true,
              expected: expected,
              expression: expr
            };
          }
          return next(null);
        }

        if (spec.as) {
          // this is a capture
          debug('capture: %s = %s', spec.as, extractedValue);
          result.captures[spec.as] = extractedValue;
          if (spec.transform) {
            let transformedValue = evil(
              result.captures,
              spec.transform);

            debug('transform: %s = %s', spec.as, result.captures[spec.as]);
            result.captures[spec.as] = transformedValue !== null ? transformedValue : extractedValue;
          }
        }

        return next(null);
      });
    },
    function(err) {
      if (err) {
        return done(err, null);
      } else {
        return done(null, result);
      }
    });
}

function parseSpec(spec, response) {
  let parser;
  let extractor;
  let expr;

  if (spec.json) {
    parser = parseJSON;
    extractor = extractJSONPath;
    expr = spec.json;
  } else if (xmlCapture && spec.xpath) {
    parser = xmlCapture.parseXML;
    extractor = xmlCapture.extractXPath;
    expr = spec.xpath;
  } else if (spec.regexp) {
    parser = dummyParser;
    extractor = extractRegExp;
    expr = spec.regexp;
  } else if (spec.header) {
    parser = dummyParser;
    extractor = extractHeader;
    expr = spec.header;
  } else if (spec.selector) {
    parser = dummyParser;
    extractor = extractCheerio;
    expr = spec.selector;
  } else {
    if (isJSON(response)) {
      parser = parseJSON;
      extractor = extractJSONPath;
      expr = spec.json;
    } else if (xmlCapture && isXML(response)) {
      parser = xmlCapture.parseXML;
      extractor = xmlCapture.extractXPath;
      expr = spec.xpath;
    } else {
      // We really don't know what to do here.
      parser = dummyParser;
      extractor = dummyExtractor;
      expr = '';
    }
  }

  return { parser: parser, extractor: extractor, expr: expr };
}

/*
 * Wrap JSON.parse in a callback
 */
function parseJSON(body, callback) {
  let r = null;
  let err = null;

  try {
    if (typeof body === 'string') {
      r = JSON.parse(body);
    } else {
      r = body;
    }
  } catch(e) {
    err = e;
  }

  return callback(err, r);
}

function dummyParser(body, callback) {
  return callback(null, body);
}

// doc is a JSON object
function extractJSONPath(doc, expr) {
  let results = jsonpath.eval(doc, expr);
  if (results.length > 1) {
    return results[randomInt(0, results.length - 1)];
  } else {
    return results[0];
  }
}

// doc is a string or an object (body parsed by Request when headers indicate JSON)
function extractRegExp(doc, expr, opts) {
  let group = opts.group;
  let str;
  if (typeof doc === 'string') {
    str = doc;
  } else {
    str = JSON.stringify(doc); // FIXME: not the same string as the one we got from the server
  }
  let rx = new RegExp(expr);
  let match = rx.exec(str);
  if(group && match[group]) {
    return match[group];
  } else if (match[0]) {
    return match[0];
  } else {
    return '';
  }
}

function extractHeader(headers, headerName) {
  return headers[headerName];
}

function extractCheerio(doc, expr, opts) {
  let $ = cheerio.load(doc);
  let els = $(expr);
  let i = 0;
  if (typeof opts.index !== 'undefined') {
    if (opts.index === 'random') {
      i = Math.ceil(Math.random() * els.get().length - 1);
    } else if (opts.index === 'last') {
      i = els.get().length() - 1;
    } else if (typeof Number(opts.index) === 'number') {
      i = Number(opts.index);
    }
  }
  return els.slice(i, i + 1).attr(opts.attr);
}

function dummyExtractor() {
  return '';
}

/*
 * Given a response object determine if it's JSON
 */
function isJSON(res) {
  debug('isJSON: content-type = %s', res.headers['content-type']);
  return (res.headers['content-type'] &&
          /^application\/json/.test(res.headers['content-type']));
}

/*
 * Given a response object determine if it's some kind of XML
 */
function isXML(res) {
  return (res.headers['content-type'] &&
          (/^[a-zA-Z]+\/xml/.test(res.headers['content-type']) ||
           /^[a-zA-Z]+\/[a-zA-Z]+\+xml/.test(res.headers['content-type'])));

}

function randomInt (low, high) {
  return Math.floor(Math.random() * (high - low + 1) + low);
}
