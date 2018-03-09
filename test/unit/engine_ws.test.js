/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

'use strict';

const EventEmitter = require('events');
const test = require('tape');
const WsEngine = require('../../lib/engine_ws');

const createServer = require('../targets/simple_ws');

const port = 3003;
const script = {
  config: {
    target: 'ws://localhost:'+port,
    variables: {
      id: [ "a" ]
    }
  },
  scenarios: [
    {
      name: 'Whatever',
      path: '/path?id={{ id }}',
      flow: [
        {
          send: "message"
        }
      ]
    }
  ]
};

test('WebsocketEngineInterface', function(t) {
  t.plan(2);

  const engine = new WsEngine(script);
  const ee = new EventEmitter();

  const runScenario = engine.createScenario(script.scenarios[0], ee);

  t.assert(engine, 'Can init the engine');
  t.assert(typeof runScenario === 'function', 'Can create a virtual user function');

  t.end();
});

test('Websocket connection at configured and templated path', function(t) {
  t.plan(3);

  const target = createServer(port);

  const engine = new WsEngine(script);
  const ee = new EventEmitter();

  const runScenario = engine.createScenario(script.scenarios[0], ee);

  target.on('connection', function connection(ws) {
    t.assert(true, 'Connected to target');
  });

  const initialContext = { vars: { id: "some-var" } };
  runScenario(initialContext, function userDone(err, finalContext) {
    t.assert(!err, 'Scenario didn\'t err');
    t.assert(finalContext.ws.url === 'ws://localhost:3003/path?id=some-var');
  });
});
