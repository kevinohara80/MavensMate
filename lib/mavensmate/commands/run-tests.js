/* compile-metadata commander component
 * To use add require('../cmds/compile-metadata.js')(program) to your commander.js based node executable before program.parse
 */
'use strict';

var util                  = require('../util').instance;
var inherits              = require('inherits');
var BaseCommand           = require('../command');
var ApexTest              = require('../test');
// var Renderer               = require('../ui/renderer');

function Command() {
  Command.super_.call(this, Array.prototype.slice.call(arguments, 0));
}

inherits(Command, BaseCommand);

Command.prototype.execute = function() {
  var self = this;
  self.payload.project = self.getProject(); 
  var test = new ApexTest(self.payload);
  test.execute()
    .then(function(testResults) {
        self.respond(testResults);
    })
    ['catch'](function(error) {
      self.respond('Could not run tests', false, error);
    })
    .done();  
};

exports.command = Command;
exports.addSubCommand = function(client) {
  client.program
    .command('run-tests')
    .alias('test')
    .option('--ui', 'Launches the Apex test runner UI.')
    .version('0.0.1')
    .description('Runs Apex unit tests')
    .action(function(){
      var self = this;
      util.getPayload()
        .then(function(payload) {
          client.executeCommand(self._name, payload); 
        });
    });
};