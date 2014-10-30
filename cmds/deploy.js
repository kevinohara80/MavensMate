/* compile-metadata commander component
 * To use add require('../cmds/compile-metadata.js')(program) to your commander.js based node executable before program.parse
 */
'use strict';

var util 							= require('../lib/util').instance;
var Project 					= require('../lib/project');
var Deploy  					= require('../lib/deploy');

var Command = function(){};

Command.execute = function(command) {
	var self = command;

	util.getPayload()
		.then(function() {
			global.project = new Project();
			return global.project.initialize();
		})
		.then(function() {
			var deploy = new Deploy(global.payload);
			return deploy.execute();
		})
		.then(function(result) {
			util.respond(self, result);
		})
		['catch'](function(error) {
			util.respond(self, 'Could not compile metadata', false, error);
		})
		.done();	
};

exports.command = Command;
exports.addSubCommand = function(program) {
	program
		.command('deploy')
		.version('0.0.1')
		.description('Deploys metadata to one or more salesforce.com servers')
		.action(function(/* Args here */){
			Command.execute(this);
		});
};