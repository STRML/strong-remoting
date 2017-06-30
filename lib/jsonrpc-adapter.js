'use strict';
/*!
 * Expose `JsonRpcAdapter`.
 */

module.exports = JsonRpcAdapter;

/*!
 * Module dependencies.
 */

var EventEmitter = require('events').EventEmitter;
var debug = require('debug')('strong-remoting:jsonrpc-adapter');
var util = require('util');
var inherits = util.inherits;
var jayson = require('jayson');
var express = require('express');
var HttpContext = require('./http-context');


/**
 * Create a new `JsonRpcAdapter` with the given `options`.
 *
 * @param {Object} options
 * @return {JsonRpcAdapter}
 */

function JsonRpcAdapter(remotes) {
  EventEmitter.call(this);

  this.remotes = remotes;
  this.Context = HttpContext;
}

/**
 * Inherit from `EventEmitter`.
 */

inherits(JsonRpcAdapter, EventEmitter);

/*!
 * Simplified APIs
 */

JsonRpcAdapter.create =
  JsonRpcAdapter.createJsonRpcAdapter = function(remotes) {
    // add simplified construction / sugar here
    return new JsonRpcAdapter(remotes);
  };

/**
 * Get the path for the given method.
 */

JsonRpcAdapter.prototype.getRoutes = function(obj) {
  // build default route
  var routes = [
    {
      verb: 'POST',
      path: obj.name ? ('/' + obj.name) : ''
    }
  ];
  return routes;
};

JsonRpcAdapter.errorHandler = function() {
  return function restErrorHandler(err, req, res, next) {
    if (typeof err === 'string') {
      err = new Error(err);
      err.status = err.statusCode = 500;
    }

    res.statusCode = err.statusCode || err.status || 500;

    debug('Error in %s %s: %s', req.method, req.url, err.stack);
    var data = {
      name: err.name,
      status: res.statusCode,
      message: err.message || 'An unknown error occurred'
    };

    for (var prop in err) {
      data[prop] = err[prop];
    }

    // TODO(bajtos) Remove stack info when running in production
    data.stack = err.stack;

    res.send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Server error', data: data },
      id: null
    });
  };
};

// A mock wrapper function to help code generation.
// Note that we can't make it a real function and use .toString() on it because
// that causes a whole world of trouble when we run strong-remoting's unit tests
// with code coverage.
var mockWrapper = [
'function mockWrapper(method) {',
'  return function(__args__) {',
'    var args = Array.prototype.slice.call(arguments);',
'    if (method.isStatic) {',
'      method.getFunction().apply(method.ctor, args);',
'    } else {',
'      method.sharedCtor.invoke(method, function(err, instance) {',
'        method.getFunction().apply(instance, args);',
'      });',
'    }',
'  };',
'}',
].join('\n');

/* istanbul ignore next */
JsonRpcAdapter.prototype.createHandler = function() {

  var root = express.Router();
  var classes = this.remotes.classes();

  root.use(JsonRpcAdapter.errorHandler());

  classes.forEach(function(sc) {
    var server = new jayson.server();
    root.post('/' + sc.name + '/jsonrpc',
      new jayson.server.interfaces.middleware(server, {}));

    var methods = sc.methods();

    methods.forEach(function(method) {
      // Wrap the method so that it will keep its own receiver - the shared class
      var argsNames = '';
      if (method.accepts) {
        argsNames = method.accepts.map(function(item) {
          return item.arg;
        });
        argsNames = argsNames.join(',');
      } else {
        var m = method.getFunction();
        if (m.length > 1) {
          // The method has more args than cb
          // Build dummy param names
          var names = [];
          for (var i = 0; i < m.length - 1; i++) {
            names.push('param' + i);
          }
          argsNames = names.join(',');
        }
      }
      argsNames = argsNames ? argsNames + ',cb' : 'cb';

      // Generate the function based on the wrapper
      // We need to remove the header/footer to get the function body
      var funcBody = mockWrapper.toString().
        replace('function mockWrapper(method) {', '').
        replace('__args__', argsNames).
        replace(/}$/, '');
      /*jslint evil: true */
      var fn = new Function('method', funcBody)(method);
      if (debug.enabled) {
        debug('Generated function: %s', fn.toString());
      }
      server.method(method.name, fn);
    });

  });

  return root;
};

JsonRpcAdapter.prototype.allRoutes = function() {
  var routes = [];
  var adapter = this;
  var classes = this.remotes.classes();
  var currentRoot = '';

  classes.forEach(function(sc) {
    adapter
      .getRoutes(sc)
      .forEach(function(classRoute) {
        currentRoot = classRoute.path;
        var methods = sc.methods();

        var functions = [];
        methods.forEach(function(method) {
          // Use functions to keep track of JS functions to dedupe
          if (functions.indexOf(method.fn) === -1) {
            functions.push(method.fn);
          } else {
            return; // Skip duplicate methods such as X.m1 = X.m2 = function() {...}
          }
          adapter.getRoutes(method).forEach(function(route) {
            if (method.isStatic) {
              addRoute(route.verb, route.path, method);
            } else {
              adapter
                .getRoutes(method.sharedCtor)
                .forEach(function(sharedCtorRoute) {
                  addRoute(route.verb, sharedCtorRoute.path + route.path, method);
                });
            }
          });
        });
      });
  });

  return routes;

  function addRoute(verb, path, method) {
    if (path === '/' || path === '//') {
      path = currentRoot;
    } else {
      path = currentRoot + path;
    }

    if (path[path.length - 1] === '/') {
      path = path.substr(0, path.length - 1);
    }

    // TODO this could be cleaner
    path = path.replace(/\/\//g, '/');

    routes.push({
      verb: verb,
      path: path,
      description: method.description,
      notes: method.notes,
      method: method.stringName,
      accepts: (method.accepts && method.accepts.length) ? method.accepts : undefined,
      returns: (method.returns && method.returns.length) ? method.returns : undefined,
      errors: (method.errors && method.errors.length) ? method.errors : undefined
    });
  }
};
