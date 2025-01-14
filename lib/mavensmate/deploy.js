'use strict';
var Q                 = require('q');
var _                 = require('lodash');
var temp              = require('temp');
var swig              = require('swig');
var fs                = require('fs-extra');
var path              = require('path');
var util              = require('./util').instance;
var events            = require('events');
var inherits          = require('inherits');
var SalesforceClient  = require('./sfdc-client');
var MetadataService   = require('./metadata').MetadataService;
var logger            = require('winston');
var config            = require('./config');

// Q.longStackSupport = true;
// TODO: create tmp directory on instantiation, set as property
// TODO: refactor execute... methods

/**
 * Represents a deployment to one or more Salesforce.com servers
 * @param {Object} opts
 * @param {Array} opts.project - Project instance
 * @param {Array} opts.destinations - array of org connections
 * @param {Array} opts.checkOnly - whether this is a validate-only deployment
 * @param {Array} opts.runTests - whether to run tests during this deployment
 * @param {Array} opts.rollbackOnError - whether to rollback when the deployment fails
 * @param {Array} opts.package - deployment payload
 * @param {Array} opts.newDeploymentName - the name of the deployment to be saved for future deploys
 * @param {Array} opts.debugCategories - array of debug categories for the deployment
 */
function Deploy(opts) {
  util.applyProperties(this, opts);
  this.metadataService = new MetadataService({ sfdcClient: this.project.sfdcClient });
}

inherits(Deploy, events.EventEmitter);

Deploy.prototype._getTargets = function() {
  return this.destinations || [];
};

/**
 * Compiles files via Metadata API
 * @param  {Array of Metadata} metadata - metadata to be compiled (must already exist in salesforce)
 * @return {Promise}
 */
Deploy.prototype.compileWithMetadataApi = function(metadata) {
  var deferred = Q.defer();
  var self = this;

  logger.debug('compiling metadata via metadata api: ');
  // logger.debug(metadata);

  self.stage(metadata)
    .then(function(zipStream) {
      process.chdir(self.project.path);
      return self.project.sfdcClient.deploy(zipStream, { rollbackOnError : true });
    })
    .then(function(result) {
      logger.debug('Compile result: ');
      logger.debug(result);
      deferred.resolve(result);
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done(); 

  return deferred.promise;
};

Deploy.prototype.executeRemote = function(deployOptions) {
  var deferred = Q.defer();
  var self = this;
  var deployPromises = [];
  deployOptions = deployOptions || {
    rollbackOnError: true,
    performRetrieve: true
  };
  
  var newPath = temp.mkdirSync({ prefix: 'mm_' });
  var retrieveResultStream;
  // var fileProperties;
  self.project.sfdcClient.retrieveUnpackaged(self.package)
    .then(function(retrieveResult) {
      retrieveResultStream = retrieveResult.zipStream;
      // fileProperties = retrieveResult.fileProperties;
      return util.writeStream(retrieveResultStream, newPath);
    })
    .then(function() {
      _.each(self._getTargets(), function(target) {
        logger.debug('adding compare target: ');
        logger.debug(target);
        logger.debug(deployOptions);
        deployPromises.push(self._deployToTarget(target, newPath, deployOptions));
      });
      return Q.all(deployPromises);
    })
    .then(function(deployResults) {
      var result = {};
      _.each(deployResults, function(deployResult) {
        var username = Object.keys(deployResult)[0];
        result[username] = deployResult[username];
        if (result[username].details.componentFailures) {
          if (!_.isArray(result[username].details.componentFailures)) {
            result[username].details.componentFailures = [result[username].details.componentFailures];
          }
        }
        if (result[username].details.componentSuccesses) {
          if (!_.isArray(result[username].details.componentSuccesses)) {
            result[username].details.componentSuccesses = [result[username].details.componentSuccesses];
          }
        }
        if (result[username].details.runTestResult && result[username].details.runTestResult.codeCoverageWarnings) {
          if (!_.isArray(result[username].details.runTestResult.codeCoverageWarnings)) {
            result[username].details.runTestResult.codeCoverageWarnings = [result[username].details.runTestResult.codeCoverageWarnings];
          }
        }
      });
      deferred.resolve(result);
    })
    ['catch'](function(err) {
      deferred.reject(new Error('Could not complete deployment: '+err.message));
    })
    .done();

  return deferred.promise;
};

/**
 * Takes an array of Metadata instances and prepares a local deployment zip to be passed to the Metadata API for deployment
 * @param  {Array} of type Metadata - metadata
 * @return {Promise} resolves with zip stream
 */
Deploy.prototype.stage = function(metadata) {
  var deferred = Q.defer();
  var self = this;

  // TODO: handle folder-based metadata, like documents, templates
  // recurse upward looking for valid folder name, if reach path.join(workspace, projectname), then not valid?

  // writes temp directory, puts zip file inside
  var newPath = temp.mkdirSync({ prefix: 'mm_' });

  fs.mkdirpSync(path.join(newPath, 'unpackaged'));

  var metadataObject = self.metadataService.objectify(metadata);

  self.writePackage(metadataObject, path.join(newPath, 'unpackaged'))
    .then(function() {
      _.each(metadata, function(m) {
        var metadataPath = m.getPath();
        // metadataPath => /foo/bar/myproject/unpackaged/classes/myclass.cls

        var fileBasename = path.basename(metadataPath);
        // fileBaseName => myclass.cls

        var directory = path.dirname(metadataPath); 
        // directory => /foo/bar/myproject/unpackaged/classes
        
        var projectSrc = path.join(self.project.workspace, self.project.projectName, 'src');
        var destinationDirectory = directory.replace(projectSrc, path.join(newPath, 'unpackaged')); 
        // destinationDirectory => /foo/bar/myproject/unpackaged/classes

        // make directory if it doesnt exist (parent dirs included)
        if (!fs.existsSync(destinationDirectory)) {
          fs.mkdirpSync(destinationDirectory); 
        }

        // copy to tmp
        fs.copySync(metadataPath, path.join(destinationDirectory, fileBasename));

        if (m.hasMetaFile()) {
          if (m.isMetaFile()) {
            fs.copySync(metadataPath.replace('-meta.xml',''), path.join(destinationDirectory, fileBasename.replace('-meta.xml', '')));
          } else {
            fs.copySync(metadataPath+'-meta.xml', path.join(destinationDirectory, fileBasename+'-meta.xml'));
          }
        }
      }); 
      
      return util.zipDirectory(path.join(newPath, 'unpackaged'), newPath);
    })
    .then(function() {
      var zipStream = fs.createReadStream(path.join(newPath, 'unpackaged.zip'));
      deferred.resolve(zipStream);  
    })
    ['catch'](function(err) {
      deferred.reject(new Error('Could not prepare metadata for deployment: '+err));
    })
    .done();
  
  return deferred.promise;
};

/**
 * Deploys zipStream to project's sfdcClient
 * @param  {Stream} zipStream - zipped deployment 
 * @return {[type]}           [description]
 */
Deploy.prototype.executeStream = function(zipStream) {
  var deferred = Q.defer();
  var self = this;
  self.project.sfdcClient.deploy(zipStream, { rollbackOnError : true })
    .then(function(result) {
      deferred.resolve(result);
    })
    ['catch'](function(error) {
      deferred.reject(error);
    })
    .done(); 
  return deferred.promise;
};

/**
 * Deploys instance to server, creating a server copy, places in self.project
 * @return {Promise} - resolves with Object response from Salesforce
 */
Deploy.prototype.execute = function(metadata, deployOptions) {
  var deferred = Q.defer();
  var self = this;

  if (!deployOptions) {
    deployOptions = {
      rollbackOnError: true
    };
  }

  var newPath = temp.mkdirSync({ prefix: 'mm_' });
  logger.debug('deploying metadata: ');
  // logger.debug(metadata);
  var metadataObject = self.metadataService.objectify(metadata);
  self.writePackage(metadataObject, path.join(newPath, 'unpackaged'))
    .then(function() {
      return metadata.writeFile(newPath);
    })
    .then(function() {
      return util.zipDirectory(path.join(newPath, 'unpackaged'), newPath);
    })
    .then(function() {
      process.chdir(self.project.path);
      var zipStream = fs.createReadStream(path.join(newPath, 'unpackaged.zip'));
      return self.project.sfdcClient.deploy(zipStream, deployOptions);
    })
    .then(function(result) {
      logger.debug('New metadata creation result: ');
      logger.debug(result);
      if (result.success) {
        var metadataPath = path.join(newPath, 'unpackaged', metadata.getType().directoryName, metadata.getName()+'.'+metadata.getType().suffix);
        // metadataPath => /my/tmp/directory/unpackaged/classes/myclass.cls

        var fileBasename = path.basename(metadataPath);
        // fileBaseName => myclass.cls

        var directory = path.dirname(metadataPath); 
        // directory => /my/tmp/directory/unpackaged/classes
        
        var projectSrc = path.join(self.project.workspace, self.project.projectName, 'src');
        // projectSrc => /foo/bar/myproject/src

        var destinationDirectory = directory.replace(path.join(newPath, 'unpackaged'), projectSrc); 
        // destinationDirectory => /foo/bar/myproject/src/classes

        // make directory if it doesnt exist (parent dirs included)
        if (!fs.existsSync(destinationDirectory)) {
          fs.mkdirpSync(destinationDirectory); 
        }

        // copy to project
        // console.log(metadataPath);
        // console.log(path.join(destinationDirectory, fileBasename));
        fs.copySync(metadataPath, path.join(destinationDirectory, fileBasename));

        if (metadata.hasMetaFile()) {
          fs.copySync(metadataPath+'-meta.xml', path.join(destinationDirectory, fileBasename+'-meta.xml'));
        }  
      }
      deferred.resolve(result);
    })
    ['catch'](function(error) {
      logger.debug('Error deploying new metadata to server');
      logger.debug(error.stack);
      deferred.reject(new Error('Could not deploy metadata to server: '+error));
    })
    .done();           

  return deferred.promise;
};

Deploy.prototype._deployToTarget = function(target, deployPath, deployOptions) {
  var deferred = Q.defer();
  // var self = this;

  // if using keyring, retrieve password (otherwise it will be a property of the target)
  if (!target.password) {
    target.password = util.getPassword(target.id);
  }

  logger.debug('deploying to target: ');
  logger.debug(target.username);
  logger.debug(target.password);
  logger.debug('deploy options:');
  logger.debug(deployOptions);
  
  var deployClient;
  var deployStream;

  util.zipDirectory(path.join(deployPath, 'unpackaged'), deployPath)
    .then(function() {
      deployClient = new SalesforceClient({ username: target.username, password: target.password });
      return deployClient.initialize();
    })
    .then(function() {
      deployClient.setPollingTimeout(300000); // TODO: make configurable from UI
      deployStream = fs.createReadStream(path.join(deployPath, 'unpackaged.zip'));
      return deployClient.deploy(deployStream, deployOptions);
    })
    .then(function(deployResult) {
      var result = {};
      result[target.username] = deployResult;
      deferred.resolve(result);
    }) 
    ['catch'](function(err) {
      logger.debug('_deployToTarget failed');
      logger.debug(err);
      deferred.reject(new Error('Could not deploy to target: '+target.username+', '+err.message));
    })
    .done();

  return deferred.promise;
};

/**
 * Writes a file in package.xml format based on specified metadata object
 * @param  {Object} objectifiedMetadata
 * @param  {String} destination
 * @param  {String} fileName - leave blank for 'package.xml', specify 'destructiveChanges.xml' for deletion deploy
 * @return {Promise}
 */
Deploy.prototype.writePackage = function(objectifiedMetadata, destination, fileName) {
  var deferred = Q.defer();
  if (fileName === undefined) {
    fileName = 'package.xml';
  }
  var file = path.join(destination, fileName);
  var fileBody = swig.renderFile('package.xml', {
    obj: objectifiedMetadata,
    apiVersion: config.get('mm_api_version')
  });
  fs.outputFile(file, fileBody, function(err) {
    if (err) {
      deferred.reject(err);  
    } else {
      deferred.resolve();
    }
  });
  return deferred.promise;
};

/**
 * Takes an array of Metadata instances and prepares a local deployment zip to be passed to the Metadata API for deletion
 * @param  {Array} of type Metadata - metadata
 * @return {Promise} resolves with zip stream
 */
Deploy.prototype.stageDelete = function(metadata) {
  var deferred = Q.defer();
  var self = this;
  // TODO: handle folder-based metadata, like documents, templates
  // recurse upward looking for valid folder name, if reach path.join(workspace, projectname), then not valid?

  // writes temp directory, puts zip file inside
  var newPath = temp.mkdirSync({ prefix: 'mm_' });

  fs.mkdirpSync(path.join(newPath, 'unpackaged'));

  var metadataObject = self.metadataService.objectify(metadata);

  self.writePackage(metadataObject, path.join(newPath, 'unpackaged'), 'destructiveChanges.xml')
    .then(function() {
      return self.writePackage({}, path.join(newPath, 'unpackaged'), 'package.xml');
    })
    .then(function() {
      return util.zipDirectory(path.join(newPath, 'unpackaged'), newPath);
    })
    .then(function() {
      var zipStream = fs.createReadStream(path.join(newPath, 'unpackaged.zip'));
      deferred.resolve(zipStream);  
    })
    ['catch'](function(err) {
      deferred.reject(new Error('Could not prepare metadata for deletion: '+err));
    })
    .done();
  return deferred.promise;
};


module.exports = Deploy;