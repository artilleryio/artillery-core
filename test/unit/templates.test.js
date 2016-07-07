'use strict';

var test = require('tape');
var template = require('../../lib/engine_util').template;

// TODO:
// string with a function
// string with multiple functions
// string with a function and a {{}}
// functions that aren't defined

var emptyContext = { vars: {} };

test('templating a plain string should return the same string', function(t) {
  t.assert(template('string', emptyContext) === 'string', '');
  t.assert(template('string {}', emptyContext) === 'string {}', '');
  t.end();
});

test.test('string variables can be substituted', function(t) {
  t.assert(template('hello {{name}}', { vars: { name: 'Hassy'} }) === 'hello Hassy', '');
  t.assert(template('hello {{name}}', emptyContext) === 'hello ', '');
  t.end();
});

test.test('strings with multiple variables can be substituted', function(t) {
  t.assert(template('hello {{nameFirst}} {{nameLast}}', { vars: { nameFirst: 'Neil', nameLast: 'Armstrong'} }) === 'hello Neil Armstrong', '');
  t.end();
});

test.test('substituted string variables are not HTML escaped', function(t) {
  t.equal(template('{{lawFirm}}', { vars: { lawFirm: 'Michelson, Jones & Peterson LLC.'} }), 'Michelson, Jones & Peterson LLC.', '');
  t.end();
});

test.test('numeric variables can be substituted', function(t) {
  t.equal(template('{{int}}', { vars: { int: 5 } }), 5, '');
  t.end();
});

test.test('whole objects can be substituted', function(t) {
  t.deepEqual(template('{{obj}}', { vars: { obj: { nested: 'data' } } }), { nested: 'data' }, '');
  t.end();
});

test.test('when concatenated with other strings, null and undefined are substituted as an empty string', function(t) {
  t.equal(template('hello {{name}}', { vars: { name: null } }), 'hello ', '');
  t.equal(template('hello {{name}}', { vars: { name: undefined } }), 'hello ', '');
  t.equal(template('hello {{name}}', { vars: {} }), 'hello ', '');
  t.end();
});

test.test('when substituted on their own, null and undefined retain their original values', function(t) {
  t.equal(template('{{name}}', { vars: { name: null } }), null, '');
  t.equal(template('{{name}}', { vars: { name: undefined } }), undefined, '');
  t.equal(template('{{name}}', { vars: {} }), undefined, '');
  t.end();
});

test.test('dotted variables can be substituted', function(t) {
  const context = {
    vars: {
      nested: {
        str: 'someText',
        int: 5,
        emptyString: '',
        explicitNull: null,
        explicitUndefined: undefined,
        deeply: {
          some: 'data'
        }
      }
    }
  };
  t.deepEqual(template('{{nested.str}}', context), 'someText', '');
  t.deepEqual(template('{{nested.int}}', context), 5, '');
  t.deepEqual(template('{{nested.emptyString}}', context), '', '');
  t.deepEqual(template('{{nested.explicitNull}}', context), null, '');
  t.deepEqual(template('{{nested.explicitUndefined}}', context), undefined, '');
  t.deepEqual(template('{{nested.deeply}}', context), {some: 'data'}, '');
  t.deepEqual(template('{{nested.implicitUndefined}}', context), undefined, '');
  t.end();
});
