var fs = require('fs');
var path = require('path');
var zlib = require('zlib');
var spawn = require('child_process').spawn;
var debug = require('debug')('npm-install');
var barrage = require('barrage');
var fetch = require('npm-fetch');
var after = require('after');
var temp = require('temp');
var inorder = require('in-order');
var rimraf = require('rimraf');
var tar = require('tar');

// setup gyp command for spawn
var gyp_cmd = path.resolve(require.resolve('node-gyp'), '..', '../bin/node-gyp.js');
debug('gyp command: %s', gyp_cmd);

// read pkg json file and return array of deps { name, spec }
function read_pkg_json(fullpath, cb) {
    fs.readFile(fullpath, 'utf8', function(err, data) {
        if (err) {
            return cb(err);
        }

        try {
            var pkg = JSON.parse(data);
            var deps = pkg.dependencies || {};

            cb(null, Object.keys(deps).map(function(name) {
                return {
                    name: name,
                    spec: deps[name]
                }
            }));
        } catch (err) {
            return cb(err);
        }
    });
}

// TODO
// return a logging emitter
// which will emit 'info', 'warn', 'error' events?
// maybe should detail for which package?
// or full package path as well module:submodule:submodule
// also, 'stdout', 'stderr'

function perform_install(name, spec, pkg_path, destination, cb) {

    if (fs.existsSync(destination)) {
        // remove symlinks nicely
        var stat = fs.lstatSync(destination);
        if (stat.isSymbolicLink()) {
            fs.unlinkSync(destination);
        }
        else {
            rimraf.sync(destination);
        }
    }

    var items = fs.readdirSync(pkg_path);

    if (items.length !== 1) {
        return cb(new Error('unexpected number of items in donwload dir'));
    }

    pkg_path = path.join(pkg_path, items[0]);

    fs.renameSync(pkg_path, destination);

    // install the deps for the module we installed
    install(destination, function(err) {
        if (err) {
            return cb(err);
        }

        // run build in final_dest
        build(destination, function(err) {
            if (err) {
                return cb(err);
            }

            // install specfile
            var specfile = path.join(destination, '.npm-install-info');
            var key = name + ':' + spec;
            fs.writeFileSync(specfile, key);
            cb();
        });
    });
}

function install(where, cb) {
    var pkgfile = path.join(where, 'package.json');

    if (!fs.existsSync(pkgfile)) {
        return cb();
    }

    read_pkg_json(pkgfile, function(err, deps) {
        if (err) {
            return cb(err);
        }

        if (deps.length === 0) {
            return cb();
        }

        var module_dir = path.join(path.dirname(pkgfile), 'node_modules');

        // make module dir if we don't have it
        if (!fs.existsSync(module_dir)) {
            fs.mkdirSync(module_dir);
        }

        // TODO
        // we can download the deps in parallel
        // but we should do the actual install in order

        // deps we have downloaded cause we need to install them
        var downloaded_deps = [];

        var done = after(deps.length, function(err) {
            if (err) {
                // TODO remove all temp dirs?
                return cb(err);
            }

            // loop deps and install each dep
            inorder(downloaded_deps, function(dep, done) {
                perform_install(dep.name, dep.spec, dep.pkg_path, dep.destination, done);
            }, cb)
        });

        // async fetch of deps
        deps.forEach(function(dep) {
            // final destination for module
            var final_dest = path.join(module_dir, dep.name);

            // if the directory exists we need to make sure that we meet criteria for install
            if (fs.existsSync(final_dest)) {

                // avoid installing over symlinks
                var stat = fs.lstatSync(final_dest);
                if (stat.isSymbolicLink()) {
                    return done();
                }

                var specfile = path.join(final_dest, '.npm-install-info');
                if (fs.existsSync(specfile)) {
                    var content = fs.readFileSync(specfile, 'utf8');
                    var key = dep.name + ':' + dep.spec;
                    if (content === key) {
                        return done();
                    }
                }
            }

            console.log('downloading %s : %s', dep.name, dep.spec);

            var tar_opt = {
                path: temp.path({ prefix: 'npminstall-' })
            };

            process.setMaxListeners(0);
            process.once('exit', function() {
                rimraf.sync(tar_opt.path, function() {});
            });

            fetch(dep.name, dep.spec, {})
            .syphon(barrage(zlib.createGunzip()))
            .syphon(barrage(tar.Extract(tar_opt)))
            .wait(function(err) {
                if (err) {
                    return done(err);
                }

                downloaded_deps.push({
                    name: dep.name,
                    spec: dep.spec,
                    destination: final_dest,
                    pkg_path: tar_opt.path
                });

                return done();
            });
        });
    });
}

function build(where, cb) {
    var bindings_file = path.join(where, 'binding.gyp');

    // nothing to build
    if (!fs.existsSync(bindings_file)) {
        return cb();
    }

    var cp_args = {
        cwd: where
    };

    var cp = spawn(gyp_cmd, ['configure'], cp_args);
    cp.on('close', function(code) {
        if (code !== 0) {
            return cb(new Error('could not configure'));
        }

        var cp = spawn(gyp_cmd, ['build'], cp_args);
        cp.on('close', function(code) {
            if (code !== 0) {
                return cb(new Error('could not build'));
            }

            cb();
        });
    });
}

module.exports = install;
