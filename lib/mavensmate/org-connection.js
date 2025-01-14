'use strict';
var Q                 = require('q');
var _                 = require('lodash');
var fs                = require('fs-extra');
var path              = require('path');
var util              = require('./util').instance;
var uuid              = require('node-uuid');
var SalesforceClient  = require('./sfdc-client');
var config            = require('./config');

// Q.longStackSupport = true;

/**
 * Service to get, add, update, remove org connections for a given project
 * @param {Object} project - project instance
 */
function OrgConnectionService(project) {
  this.project = project;
}

/**
 * Lists all org connections for this project
 * @return {Array} - list of connections
 */
OrgConnectionService.prototype.listAll = function() {
  var deferred = Q.defer();
  var self = this;
  fs.readJson(path.join(self.project.path, 'config', '.org_connections'), function(err, connections) {
    if (err) {
      if (err.message.indexOf('ENOENT') >= 0) {
        deferred.resolve([]);
      } else {
        deferred.reject(new Error('Could not load org connections: '+err.message));
      }
    } else {
      deferred.resolve(connections);
    }
  });
  return deferred.promise;
};

/**
 * Adds an org connection
 * @param {String} username
 * @param {String} password
 * @param {String} orgType - production, sandbox, developer
 */
OrgConnectionService.prototype.add = function(username, password, orgType) {
  var deferred = Q.defer();
  var self = this;

  var newConnectionId = uuid.v1();
  orgType = orgType || 'developer';
  var newConnection = {
    username : username,
    environment: orgType.toLowerCase(),
    id: newConnectionId
  };
  if (config.get('mm_use_keyring')) {
    util.storePassword(newConnectionId, password);
  } else {
    newConnection.password = password;
  }
  
  var orgConnectionClient = new SalesforceClient({ username: username, password: password });
  orgConnectionClient.initialize()
    .then(function() {
      if (!fs.existsSync(path.join(self.project.path, 'config', '.org_connections'))) {
        fs.outputFile(path.join(self.project.path, 'config', '.org_connections'), JSON.stringify([newConnection], null, 4), function(err) {
          if (err) {
            deferred.reject(new Error('Could not add org connection: '+err.message));
          } else {
            deferred.resolve();
          }
        });
      } else {
        fs.readJson(path.join(self.project.path, 'config', '.org_connections'), function(err, connections) {
          if (err) {
            deferred.reject(new Error('Could not load org connections: '+err.message));
          } else {
            connections.push(newConnection);
            fs.outputFile(path.join(self.project.path, 'config', '.org_connections'), JSON.stringify(connections, null, 4), function(err) {
              if (err) {
                deferred.reject(new Error('Could not add org connection: '+err.message));
              } else {
                deferred.resolve();
              }
            });
          }
        });
      }
    })
    ['catch'](function(err) {
      deferred.reject(new Error('Could not add org connection: '+err.message));
    })
    .done();

  return deferred.promise;
};

/** 
 * Updates an org connection by id
 * @param  {String} id
 * @param  {String} username
 * @param  {String} password
 * @param  {String} orgType
 * @return {Promise}
 */
OrgConnectionService.prototype.update = function(id, username, password, orgType) {
  var deferred = Q.defer();
  var self = this;
  if (!fs.existsSync(path.join(self.project.path, 'config', '.org_connections'))) {
    fs.writeSync(path.join(self.project.path, 'config', '.org_connections'), []);
  }
  fs.readJson(path.join(self.project.path, 'config', '.org_connections'), function(err, connections) {
    if (err) {
      deferred.reject(new Error('Could not load org connections: '+err.message));
    } else {
      _.each(connections, function(c) {
        if (c.id === id) {
          c.username = username;
          c.password = password;
          c.orgType = orgType.toLowerCase();
          util.replacePassword(c.id, password);
          return false;
        }
      });
      fs.outputFile(path.join(self.project.path, 'config', '.org_connections'), JSON.stringify(connections, null, 4), function(err) {
        if (err) {
          deferred.reject(new Error('Could not update org connections: '+err.message));
        } else {
          deferred.resolve();
        }
      });
    }
  });

  return deferred.promise;
};

/**
 * Removes an org connection
 * @param  {String} id
 * @return {Promise}
 */
OrgConnectionService.prototype.remove = function(id) {
  var deferred = Q.defer();
  var self = this;

  fs.readJson(path.join(self.project.path, 'config', '.org_connections'), function(err, connections) {
    if (err) {
      deferred.reject(new Error('Could not load org connections: '+err.message));
    } else {
      var newConnections = [];
      _.each(connections, function(c) {
        if (c.id !== id) {
          newConnections.push(c);
        }
      });
      fs.outputFile(path.join(self.project.path, 'config', '.org_connections'), JSON.stringify(newConnections, null, 4), function(err) {
        if (err) {
          deferred.reject(new Error('Could not write org connections: '+err.message));
        } else {
          deferred.resolve();
        }
      });
    }
  });

  return deferred.promise;
};

module.exports = OrgConnectionService;