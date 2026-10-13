'use strict';
// Every outcome code the harness can give a command, in one of six classes. The table
// lives in js/bench-core.js (b1091), where its classes are described;
// tests/bench-taxonomy.test.cjs holds it to the harness both ways.
const { CLASSES, CLASS_OF, classify } = require('../../js/bench-core.js');

module.exports = { CLASSES, CLASS_OF, classify };
