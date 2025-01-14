'use strict';
var Q               = require('q');
var _               = require('lodash');
var temp            = require('temp');
var config          = require('./config');
var path            = require('path');
var util            = require('./util').instance;
var find            = require('findit');
var logger          = require('winston');
var parseXml        = require('xml2js').parseString;
var Metadata        = require('./metadata').Metadata;
var MetadataService = require('./metadata').MetadataService;

// Q.longStackSupport = true;

/**
 * Service to get an index of an org's metadata
 * @param {Object} project - project instance (optional)
 * @param {Object} sfdcClient - client instance (optional)
 */
function IndexService(opts) {
  util.applyProperties(this, opts);
  if (this.project) {
    this.metadataService = new MetadataService({ sfdcClient : this.project.sfdcClient });
    this.sfdcClient = this.project.sfdcClient;
  } else if (this.sfdcClient) {
    this.metadataService = new MetadataService({ sfdcClient : this.sfdcClient });
  }
}

/**
 * Indexes children Metadata by preparing and submitting retrieve requests
 * @param  {Object} indexedType
 * @param  {Object} typeMap
 * @param  {String} xmlName
 * @param  {Array} childNames
 * @return {Promise}
 */
IndexService.prototype._indexChildren = function(indexedType, typeMap, xmlName, childNames) {
  var deferred = Q.defer();
  var self = this;

  try {
    var childRetrievePackage = {};
    childRetrievePackage[xmlName] = childNames;
    self.sfdcClient.retrieveUnpackaged(childRetrievePackage)
      .then(function(retrieveResult) {
        return util.writeStream(retrieveResult.zipStream, temp.mkdirSync({ prefix: 'mm_' }));
      })
      .then(function(retrievePath) {         
        var finder = find(path.join(retrievePath, 'unpackaged', typeMap[xmlName].directoryName));
        finder.on('file', function (file) { 
          
          var fileBasename = path.basename(file);
          var fileBasenameNoExtension = fileBasename.split('.')[0];
          var fileBody = util.getFileBody(file);

          var indexedChildType = _.find(indexedType.children, { 'id': [xmlName,fileBasenameNoExtension].join('.') });       
          
          // console.log('\n\n');
          // console.log(indexedChildType);
          // console.log('\n\n');

          parseXml(fileBody, function (err, xmlObject) {

            _.forOwn(xmlObject[xmlName], function(value, tagName) {

              // we're tracking this child type, now we need to add as a level 3 child
              var matchingChildType = _.find(self.metadataService.childTypes, { 'tagName': tagName });
              if (matchingChildType !== undefined) {
                
                var leaves = [];

                //now add level leaves (lowest level is 4 at the moment)
                if (!_.isArray(value)) {
                  value = [value];
                }
                _.each(value, function(item) {
                  leaves.push({
                    leaf: true,
                    checked: false,
                    level: 4,
                    text: item.fullName[0],
                    title: item.fullName[0],
                    isFolder: false,
                    id: [xmlName, fileBasenameNoExtension, tagName, item.fullName[0]].join('.'),
                    select: false
                  });
                });

                if (_.find(indexedChildType, { 'text' : tagName }) === undefined) {
                  indexedChildType.children.push({
                    checked: false,
                    level: 3,
                    id: [xmlName, fileBasenameNoExtension, tagName].join('.'),
                    text: tagName,
                    title: tagName,
                    isFolder: true,
                    children: leaves,
                    select: false,
                    cls: 'folder'
                  });
                }                  
              }
            });
          });
        });
        finder.on('end', function () {
          // todo: delete tmp directory?
          deferred.resolve(indexedType);
        });
        finder.on('error', function (err) {
          deferred.reject(new Error('Could not crawl retrieved metadata: '+err.message));
        });
      })
      ['catch'](function(err) {
        deferred.reject(new Error('Could not index metadata type '+xmlName+': ' +err.message));
      })
      .done();
  } catch(e) {
    deferred.reject('Could not index metadata type '+xmlName+': ' +e.message);
  }

  return deferred.promise;
};

/**
 * Indexes folder-based Metadata by preparing and submitting folder-based retrieve requests
 * @param  {Object} indexedType
 * @param  {Object} typeMap
 * @param  {String} xmlName
 * @return {Promise}
 */
IndexService.prototype._indexFolders = function(indexedType, typeMap, xmlName) {
  var deferred = Q.defer();
  var self = this;

  var listFolderRequests = [];

  _.each(indexedType.children, function(folder) {
    listFolderRequests.push(self.sfdcClient.listFolder(xmlName, folder.fullName));
  });

  Q.all(listFolderRequests)
    .then(function(results) {  
      
      // console.log(results);
      // console.log('---')

      _.each(results, function(r) {

        var folderName = Object.keys(r)[0];
        var folderContents = r[folderName];
        
        var indexedFolder = _.find(indexedType.children, { 'text' : folderName });

        _.each(folderContents, function(item) {
          indexedFolder.children.push({
            leaf: true, 
            title: item.fullName.split('/')[1], 
            checked: false, 
            text: item.fullName.split('/')[1], 
            level: 3, 
            isFolder: false, 
            id: [xmlName, item.fullName.split('/')[0], item.fullName.split('/')[1]].join('.'), 
            select: false
          });
        });

      });

      deferred.resolve(indexedType);
    })
    ['catch'](function(error) {
      deferred.reject(new Error('Could not finish indexing server properties: '+error.message));
    })
    .done();

  return deferred.promise;
};

/**
 * TODO: handle managed/unmanaged metadata
 * 
 * Builds a 4-level hierarchy index for the specified type
 * @param  {Object} typeListResult
 * @param  {Object} typeMap
 * @return {Promise}
 */
IndexService.prototype._indexType = function(typeListResult, typeMap) {
  var deferred = Q.defer();
  var self = this;
  // typeListResult will be an object with an xmlName key, array of results
  // { "ApexClass" : [ { "fullName" : "MyApexClass" }, { "fullName" : "MyOtherApexClass" } ] } 

  logger.debug('indexing type: ');
  logger.debug(typeListResult);

  var indexedType = {};
  var childNames = [];
  var hasChildTypes;
  var isFolderType;
  var xmlName;

  // process the type returned (ApexClass, ApexPage, CustomObject, etc.)
  _.forOwn(typeListResult, function(items, key) {
    if (util.endsWith(key,'Folder')) {
      key = self._transformFolderNameToBaseName(key);
    }

    logger.debug('key: '+key);
    logger.debug('items: ');
    logger.debug(items);

    xmlName = key;
    hasChildTypes = _.has(typeMap[key], 'childXmlNames');
    isFolderType = typeMap[key].inFolder;

    // top level (1)
    var metadataTypeDef = typeMap[key];
    indexedType.id = key;
    indexedType.type = metadataTypeDef;
    indexedType.title = key;
    indexedType.xmlName = key;
    indexedType.text = key;
    indexedType.key = key;
    indexedType.level = 1; //todo
    indexedType.hasChildTypes = hasChildTypes;
    indexedType.isFolder = true;
    indexedType.inFolder = isFolderType;
    indexedType.cls = 'folder';
    indexedType.select = false;
    indexedType.expanded = false;

    // children (2)
    _.each(items, function(item) {
      item.leaf = (hasChildTypes || isFolderType) ? false : true;
      item.title = item.fullName;
      item.checked = false;
      item.id = [key, item.fullName.replace(/\s/g,'')].join('.');
      item.text = item.fullName;
      item.cls = (hasChildTypes || isFolderType) ? 'folder' : '';
      item.level = 2;
      item.isFolder = hasChildTypes || isFolderType;
      item.children = [];
      item.select = false;

      if (hasChildTypes) {
        childNames.push(item.fullName);  
      }
    });
    
    items = _.sortBy(items, 'title');
    indexedType.children = items;
  });

  var indexPromise;
  // we need to retrieve child metadata, crawl the result and insert levels 3 and 4 of metadata
  // examples of metadata types with child types: CustomObject or Workflow
  // examples of metadata types with folders: Document or Dashboard (folders go 1-level deep currently)
  if (hasChildTypes) {
    indexPromise = self._indexChildren(indexedType, typeMap, xmlName, childNames);
  } else if (isFolderType) {
    indexPromise = self._indexFolders(indexedType, typeMap, xmlName);
  }

  if (indexPromise !== undefined) {
    indexPromise
      .then(function(result) {
        deferred.resolve(result);
      })
      ['catch'](function(err) {
        deferred.reject(new Error('Could not index children/folders for '+xmlName+': '+err.message));
      })  
      .done();
  } else {
    deferred.resolve(indexedType);
  }

  return deferred.promise;
};

/**
 * Indexes Salesforce.com org (writes to .org_metadata) based on project subscription
 * @return {Promise}
 */
IndexService.prototype.indexServerProperties = function(types) {
  var deferred = Q.defer();
  var self = this;

  if (!types) {
    types = config.get('mm_default_subscription');
  }

  logger.debug(types);

  var typeMap = {};

  var listRequests = [];
  _.each(types, function(type) {
    typeMap[type] = self.metadataService.getTypeByName(type);
    
    var typeRequestName; // name to submit to list query

    // prepare folder-based metadata for query
    var isFolderMetadata = typeMap[type].inFolder;
    if (isFolderMetadata) {
      typeRequestName = self._transformFolderNameForListRequest(type);
    } else {
      typeRequestName = type;
    }

    // console.log('submitting list query for: '+typeRequestName);
    listRequests.push(self.sfdcClient.list(typeRequestName));
  });

  Q.all(listRequests)
    .then(function(results) {  
      var typePromises = [];
      _.each(results, function(metadataListResult) {
        logger.debug(metadataListResult);
        logger.debug(typeMap);
        typePromises.push(self._indexType(metadataListResult, typeMap));
      });
      return Q.all(typePromises);
    })
    .then(function(results) {
      deferred.resolve(results);
    })
    ['catch'](function(error) {
      logger.error('An error occurred indexing server properties');
      logger.error(error.stack);
      deferred.reject(new Error('Could not finish indexing server properties: '));
    })
    .done();
      
  return deferred.promise;
};

/**
 * The Salesforce.com metadata api can be wonky, this transforms a folder type name to a list-friendly name
 * @param  {String} typeName
 * @return {String}
 */
IndexService.prototype._transformFolderNameForListRequest = function(typeName) {
  var metadataRequestType = typeName+'Folder';
  if (metadataRequestType === 'EmailTemplateFolder') {
    metadataRequestType = 'EmailFolder';
  }
  return metadataRequestType;
};

IndexService.prototype._transformFolderNameToBaseName = function(typeName) {
  if (typeName === 'EmailFolder') {
    return 'EmailTemplate';
  } else {
    return typeName.replace('Folder', '');
  }
};

/**
 * a number of protoype methods to crawl the org metadata index and select/deselect nodes
 */

IndexService.prototype.crawlDict = function(jsonData, depth, query, parentVisiblity) {
  var self = this;
  depth += 1;
  var visibility = 0;
  var childVisibility = 0;

  if (!parentVisiblity) {
    parentVisiblity = 0;
  }
  
  _.forOwn(jsonData, function(value, key) {
    if (_.isString(value) && value.toLowerCase().indexOf(query) >= 0) {
      visibility = 1;
    } else if (!_.isObject(value) && !_.isArray(value) && value.toLowerCase().indexOf(query) >= 0) {
      visibility = 1;
    }     
  });

  _.forOwn(jsonData, function(value, key) {
    if (self.crawl(value, depth, query, visibility) > 0) {
      childVisibility = 1;
    }
    if (visibility > childVisibility) {
      visibility = visibility;
    } else {
      visibility = childVisibility;
    }
  });

  jsonData.visibility = visibility;

  if (visibility === 0) {
    jsonData.cls = 'hidden';
    jsonData.addClass = 'dynatree-hidden';
  }

  return visibility;
};

IndexService.prototype.crawlArray = function(jsonData, depth, query, parentVisiblity) {
  var self = this;
  depth += 1;
  var elementsToRemove = [];
  var index = 0;
  var childVisibility;

  _.each(jsonData, function(value) {
    if (_.isString(value)) {
      childVisibility = value.toLowerCase().indexOf(query) >= 0;
    } else if (_.isObject(value)) {
      childVisibility = self.crawl(value, depth, query, parentVisiblity);
      value.index = index;
    } else {
      childVisibility = value.toLowerCase().indexOf(query) >= 0;
    }
     
    if (childVisibility === 0 && parentVisiblity === 0) {
      elementsToRemove.push(value);
      value.cls = 'hidden';
      value.addClass = 'dynatree-hidden';
    } else {
      value.expanded = true;
    }
            
    index += 1;
  });
    
};
  
IndexService.prototype.crawl = function(jsonData, depth, query, parentVisiblity) {
  var self = this;
  if (_.isArray(jsonData)) {
    self.crawlArray(jsonData, depth, query, parentVisiblity);
    _.each(jsonData, function(jd) {
      if (_.has(jd, 'visibility') && jd.visibility === 1) {
        return true;
      }
    });
    return false;
  } else if (_.isObject(jsonData)) {
    return self.crawlDict(jsonData, depth, query, parentVisiblity);
  } else {
    return 0;
  }
};

IndexService.prototype.setVisibility = function(jsonData, query) {
  this.crawl(jsonData, 0, query.toLowerCase(), 0);
};

IndexService.prototype.setChecked = function(src, ids, dpth, key) {
  // Recursively find checked item
  if (!key) {
    key = '';
  }
  if (!ids) {
    ids = [];
  }
  if (!dpth) {
    dpth = 0;
  }
  var self = this;
  if (_.isArray(src)) {
    _.each(src, function(litem) {
      if (_.isObject(litem)) {
        if (_.has(litem, 'id') && ids.indexOf(litem.id) >= 0) {
          litem.checked = true;
          litem.select = true;
        }
      }
      self.setChecked(litem, ids, dpth + 2);
    });
  } else if (_.isObject(src)) {
    _.forOwn(src, function(value, key) {
      self.setChecked(value, ids, dpth + 1, key);
    });
  }
};

IndexService.prototype.setThirdStateChecked = function(src, ids, dpth, key) {
  // Recursively find checked item
  var self = this;
  if (!key) {
    key = '';
  }
  if (!ids) {
    ids = [];
  }
  if (!dpth) {
    dpth = 0;
  }
  if (_.isArray(src)) {
    _.each(src, function(litem) {
      if (_.isObject(litem)) {
        return false;
      } 
      self.setThirdStateChecked(litem, ids, dpth + 2);
    });
  } else if (_.isObject(src)) {
    if (_.has(src, 'children') && _.isArray(src.children) && src.children.length > 0) {
      var children = src.children;
      var numberOfPossibleChecked = children.length;
      var numberOfChecked = 0;
      _.each(children, function(c) {
        if (_.has(c, 'checked') && c.checked) {
          numberOfChecked += 1;
        }
      });        
      if (numberOfPossibleChecked === numberOfChecked) {
        src.checked = true;
      } else if (numberOfChecked > 0) {
        // lineage = src.id.split('.');
        src.cls = 'x-tree-checkbox-checked-disabled';
      }
    }

    _.forOwn(src, function(value, key) {
      self.setThirdStateChecked(value, ids, dpth + 1, key);
    });
  }
};
   
module.exports = IndexService;
