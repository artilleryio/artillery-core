var Hapi = require('hapi');
var uuid = require('uuid');

var PORT = 3003;

var REQUEST_COUNT = 0;
var COOKIES = {};

var server = new Hapi.Server({
  load: {sampleInterval: 1000}
});

server.connection({
  host: '0.0.0.0',
  port: PORT
});

server.route({
  method: 'POST',
  path: '/setscookie',
  handler: setsCookie
});

server.route({
  method: 'GET',
  path: '/expectscookie',
  handler: expectsCookie,
  config: {
    state: {
      parse: true,
      failAction: 'log'
    }
  }
});

server.route({
  method: 'GET',
  path: '/pets',
  handler: index
});
server.route({
  method: 'POST',
  path: '/pets',
  handler: create
});
server.route({
  method: 'GET',
  path: '/pets/{id}',
  handler: read
});
server.route({
  method: 'GET',
  path: '/_stats',
  handler: stats
});

server.state('testCookie', {
  ttl: null,
  isSecure: true,
  isHttpOnly: true,
  encoding: 'base64json',
  clearInvalid: false,
  strictHeader: true
});

var DB = {};

server.register({
  register: require('good'),
  options: {
    opsInterval: 1000,
    reporters: [
      {
        reporter: require('good-console'),
        events: {error: '*'} //log: '*', response: '*' }
      }
    ]
  }
}, function(err) {
  if (err) {
    console.error(err);
  } else {
    server.start(function() {
      console.log('Target listening on 0.0.0.0:' + PORT);

      setInterval(function() {
        console.log(new Date());
        console.log('REQUEST_COUNT = %s', REQUEST_COUNT);
      }, 20 * 1000 * 20);
    });
  }
});

function index(req, reply) {
  //req.log(['index']);
  setTimeout(function() {
    REQUEST_COUNT++;
    reply('ok');
  }, Math.floor(Math.random() * 100));
}

function create(req, reply) {
  var id = uuid.v4().split('-')[0];
  DB[id] = req.payload;
  DB[id].id = id;
  REQUEST_COUNT++;
  return reply({id: id}).code(201);
}

function read(req, reply) {
  REQUEST_COUNT++;
  var result = DB[req.params.id];
  console.log(typeof result);
  console.log(result);
  return reply(result).code(200);
}

function stats(req, reply) {
  return reply({
    requestCount: REQUEST_COUNT,
    cookies: COOKIES
  });
}

//
// curl -v -X POST 0.0.0.0:3003/setscookie
// curl -v 0.0.0.0:3003/expectscookie -b 'testCookie=eyJ1aWQiOiIxNWMwMjNkMC02YmMxLTRkODEtYmQ1OS0wNjRmYjhmMGU0YTkifQ==;'
//

function setsCookie(req, reply) {
  var newuid = uuid.v4();
  console.log('setting testCookie.uid to %j', newuid);
  reply('ok').state('testCookie', {uid: newuid});
}

function expectsCookie(req, reply) {
  console.log('req.state.testCookie = %j', req.state.testCookie);
  if (req.state.testCookie) {
    if (COOKIES[req.state.testCookie.uid]) {
      COOKIES[req.state.testCookie.uid]++;
    } else {
      COOKIES[req.state.testCookie.uid] = 1;
    }
  }
  reply('ok');
}
