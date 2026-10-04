// Which hosts may see the screens that ask for API keys.
//
// WAR_PRIVATE_HOST decides showcase mode, which is the only thing standing between a copy of
// this page served from somewhere hostile and a visitor typing their OpenRouter key into a
// field on it. The browser suite covers the consequence (the four credential screens do not
// activate); this covers the classifier, which is a pure decision over location.hostname and
// therefore belongs in the job that runs on every push — the Playwright suites do not.
//
// The cases are the ones that were argued about when the rule was widened, plus the shapes
// that try to look private by accident: a public name that merely starts with a private
// literal must stay a showcase, and 172.32.x is outside 172.16/12 no matter how close it
// looks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// The classifier moved out of js/game.js into js/boot.js with the rest of start-up (upstream's
// boot split, review #6 step 8 — tests/boot-manifest.test.cjs now asserts game.js carries no
// WAR_PRIVATE_HOST at all). Read it where it lives: splitting game.js on this marker now
// yields undefined and the "tail" becomes one unparseable line.
const boot = fs.readFileSync(path.join(__dirname, '..', 'js', 'boot.js'), 'utf8');
if (!boot.includes('\nconst WAR_PRIVATE_HOST'))
  throw new Error('js/boot.js no longer holds WAR_PRIVATE_HOST — find the classifier before testing it');
// The tail is the classifier and the boot handlers after it; none of it runs at load beyond
// registering a load listener, which a stubbed window swallows.
const tail = 'const WAR_PRIVATE_HOST' + boot.split('\nconst WAR_PRIVATE_HOST')[1];

const verdict = (hostname, protocol = 'http:', search = '') => {
  const scope = {
    location: { hostname, protocol, search, href: protocol + '//' + hostname + search },
    window: { addEventListener() {} },
    console: { log() {}, warn() {}, error() {} },
    Math, JSON, Object, Array, String, Number, Boolean, RegExp, Error,
  };
  vm.createContext(scope);
  vm.runInContext(tail, scope, { filename: 'boot.js#tail' });
  return {
    private: vm.runInContext('WAR_PRIVATE_HOST', scope),
    local: vm.runInContext('WAR_LOCAL', scope),
    showcase: vm.runInContext('WAR_DEMO_ONLY', scope),
  };
};

test('the addresses a developer is actually on are private', () => {
  // The whole of 127/8 is loopback, not only 127.0.0.1, and a bare single-label name cannot
  // be resolved publicly — that is the rule, so the cases are the rule's own edges.
  for (const h of ['127.0.0.1', '::1', '[::1]', 'localhost', 'altertum.localhost', 'when-agents-rule.local',
    '10.20.30.40', '192.168.1.10', '172.16.0.1', '172.31.255.255', '169.254.5.6', '127.1.2.3', 'tank'])
    assert.equal(verdict(h).private, true, h + ' should open the full app');
});

test('everything the public internet can reach is a showcase', () => {
  for (const h of ['asp67.github.io', 'example.com', 'www.when-agents-rule.com', '8.8.8.8', '104.26.3.7',
    '172.32.0.1', '2001:db8::1', 'fe00::1', '1a2b:3c4d::5'])
    assert.equal(verdict(h).private, false, h + ' should never see the key fields');
});

test('a public name cannot borrow a private literal by prefixing one', () => {
  // The v4 test is anchored, and the localhost/single-label tests are suffix-aware: without
  // that, a page served from 127.0.0.1.attacker.example or localhost.attacker.example would
  // be treated as the developer's own machine.
  for (const h of ['127.0.0.1.attacker.example', 'localhost.attacker.example', 'attacker.localhost.evil',
    '10.0.0.1.example.com', 'attacker#local', 'evil/192.168.0.1'])
    assert.equal(verdict(h).private, false, h + ' is a DNS name, not an address');
  // 300.1.1.1 is not an address; treating malformed octets as private would be a fail-open.
  assert.equal(verdict('300.1.1.1').private, false);
  assert.equal(verdict('').private, false, 'an empty hostname must not be treated as home');
});

test('showcase mode is what the classifier plus the documented opt-out produce', () => {
  assert.equal(verdict('asp67.github.io').showcase, true, 'a public host is a showcase by default');
  assert.equal(verdict('asp67.github.io', 'http:', '?full=1').showcase, false,
    '?full=1 is the documented escape hatch; removing it silently strands anyone who used it');
  assert.equal(verdict('asp67.github.io', 'http:', '?v=913&full=1').showcase, false, 'it is a parameter, not the whole query');
  assert.equal(verdict('asp67.github.io', 'http:', '?fullscreen=1').showcase, true,
    'a parameter that merely starts with "full" must not unlock the key fields');
  assert.equal(verdict('', 'file:', '').local, true, 'opening index.html from disk is the local case');
  assert.equal(verdict('asp67.github.io', 'file:', '').showcase, false, 'file:// is never a showcase');
});
