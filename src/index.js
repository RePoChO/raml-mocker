'use strict';
var path = require('path'),
    fs = require('fs'),
    url = require('url'),
    async = require('async'),
    raml = require('raml-1-parser'),
    _ = require('lodash'),
    schemaMocker = require('./schema.js'),
    RequestMocker = require('./requestMocker.js');

function generate(options, callback) {
    var formats = {};
    var parserOptions = _.defaults(_.get(options, 'parserOptions'), {dereferenceSchemas: true});
    if (options) {
        if (options.formats) {
            formats = options.formats;
        }
        if (!callback || !_.isFunction(callback)) {
            console.error('[RAML-MOCKER] You must define a callback function:\n');
            showUsage();
        }
        try {
            if (options.path) {
                generateFromPath(options.path, parserOptions, formats, callback);
            } else if (options.files && _.isArray(options.files)) {
                generateFromFiles(options.files, parserOptions, formats, callback);
            }
        } catch (exception) {
            console.error('[RAML-MOCKER] A runtime error has ocurred:\n');
            console.error(exception.stack);
            showUsage();
        }
    } else {
        console.error('[RAML-MOCKER] You must define a options object:\n');
        showUsage();
    }
}

function showUsage() {
    console.log('--------------------------------------------------------------------');
    console.log('---------------------- HOW TO USE RAML MOCKER ----------------------');
    console.log('--  var ramlMocker = require(\'raml-mocker\');                      --');
    console.log('--  var options = { path: \'test/raml\' };                          --');
    console.log('--  var callback = function (requests){ console.log(requests); }; --');
    console.log('--  ramlMocker.generate(options, callback);                       --');
    console.log('--------------------------------------------------------------------');
}

function generateFromPath(filesPath, parserOptions, formats, callback) {
    fs.readdir(filesPath, function (err, files) {
        if (err) {
            throw err;
        }
        var filesToGenerate = [];
        _.each(files, function (file) {
            if (file.substr(-5) === '.raml') {
                filesToGenerate.push(path.join(filesPath, file));
            }
        });
        generateFromFiles(filesToGenerate, parserOptions, formats, callback);
    });
}

function generateFromFiles(files, parserOptions, formats, callback) {
    var requestsToMock = [];
    async.each(files, function (file, cb) {
        raml.loadApi(file, parserOptions).then(function (data) {
            getRamlRequestsToMock(data.toJSON(), '/', formats, function (reqs) {
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        }).catch(function (error) {
            cb('Error parsing: ' + error);
        });
    }, function (err) {
        if (err) {
            console.log(err);
        } else {
            callback(requestsToMock);
        }
    });
}

function getRamlRequestsToMock(definition, uri, formats, callback) {
    var requestsToMock = [];
    if (definition.relativeUri) {
        var nodeURI = definition.relativeUri;
        if (definition.uriParameters) {
            _.each(definition.uriParameters, function (uriParam, name) {
                nodeURI = nodeURI.replace('{' + name + '}', ':' + name);
            });
        }
        uri = (uri + '/' + nodeURI).replace(/\/{2,}/g, '/');
    }
    var tasks = [];
    if (definition.methods) {
        tasks.push(function (cb) {
            getRamlRequestsToMockMethods(definition, uri, formats, function (reqs) {
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        });
    }
    if (definition.resources) {
        tasks.push(function (cb) {
            getRamlRequestsToMockResources(definition, uri, formats, function (reqs) {
                requestsToMock = _.union(requestsToMock, reqs);
                cb();
            });
        });
    }
    async.parallel(tasks, function (err) {
        if (err) {
            console.log(err);
        }
        callback(requestsToMock);
    });
}

function getRamlRequestsToMockMethods(definition, uri, formats, callback) {
    var responsesByCode = [];
    _.each(definition.methods, function (method) {
        if (method.method && /get|post|put|patch|delete/i.test(method.method) && method.responses) {
            var responsesMethodByCode = getResponsesByCode(method.responses);

            var methodMocker = new RequestMocker(uri, method.method);
            var currentMockDefaultCode = null;
            _.each(responsesMethodByCode, function (reqDefinition) {

                var exampleAndMockObj = {};
                // iterate through all possible roles, can be one or more per status code
                _.each(reqDefinition.responseList, function(req) {
                    function mockData(objKey) {
                        if (req[objKey].schema) {
                            return schemaMocker(req[objKey].schema, formats);
                        }
                    }

                    exampleAndMockObj[Object.keys(req).toString()] = {
                        example: req[Object.keys(req).toString()].example ? req[Object.keys(req).toString()].example : null,
                        mock: mockData(Object.keys(req).toString())
                    };
                })

                methodMocker.addResponse(reqDefinition.code, exampleAndMockObj);
            });
            if (currentMockDefaultCode) {
                methodMocker.defaultCode = currentMockDefaultCode;
            }
            responsesByCode.push(methodMocker);
        }
    });

    callback(responsesByCode);
}

function getResponsesByCode(responses) {
    // gather responses by status codes in list
    var responsesByCodeList = [];
    _.each(responses, function (response, code) {
        var responsesByCode = [];
        if (!response) return;
        var body = response.body;

        _.each(response.body, function(body) {
            var schema = null;
            try {
                schema = body.schema && JSON.parse(body.schema);
            } catch(exception) {
                //console.log(exception.stack);
            }

            // gather example and schema to list
            responsesByCode.push({
                [body.name]: {
                    example: body.example ? body.example : null,
                    schema: schema
                }
            });
        });

        if (!_.isNaN(Number(code)) && body) {
            code = Number(code);
            // append example and schema list to responseByCodeList 
            responsesByCodeList.push({
                code: code,
                responseList: responsesByCode
            });
        }
    });

    return responsesByCodeList;
}

function getRamlRequestsToMockResources(definition, uri, formats, callback) {
    var requestsToMock = [];
    var baseUri = '';

    if (definition.baseUri && definition.baseUriParameters) {
      // extract the variables from the baseUri
      var uriElems = definition.baseUri.match(/{[a-zA-Z]+}/g);

      var tempBaseUri = definition.baseUri;
      uriElems.map(function (elem) { // e.g. elem == '{host}'
        var strippedElem = elem.replace("{","").replace("}","");
        var elemValue = definition.baseUriParameters[strippedElem].default ? definition.baseUriParameters[strippedElem].default : definition.baseUriParameters[strippedElem].name;

        if (!elemValue) {
              elemValue = definition[strippedElem];
            }
        if (elemValue) {
          tempBaseUri = tempBaseUri.replace( new RegExp(elem, 'g'), elemValue);
        } else {
          console.log("No value found for "+elem);
        }
      });
      baseUri = url.parse(tempBaseUri).pathname;
    }

    if (definition.baseUri && !definition.baseUriParameters) {
        baseUri = url.parse(definition.baseUri).pathname;
    }
    
    async.each(definition.resources, function (def, cb) {
        getRamlRequestsToMock(def, baseUri + uri, formats, function (reqs) {
            requestsToMock = _.union(requestsToMock, reqs);
            cb(null);
        });
    }, function (err) {
        if (err) {
            console.log(err);
        }

        callback(requestsToMock);
    });
}
module.exports = {
    generate: generate
};
