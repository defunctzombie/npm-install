var fs = require('fs');
var crypto = require('crypto');
var path = require('path');
var zlib = require('zlib');
var spawn = require('child_process').spawn;
var debug = require('debug')('npm-install');
var barrage = require('barrage');
var fetch = require('npm-fetch');
var after = require('after');
var inorder = require('in-order');
var rimraf = require('rimraf');
var tar = require('tar');
var osenv = require('osenv');

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

function perform_install(name, spec, tarfile, destination, cb) {

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

    var tar_opt = {
        path: destination,
        strip: 1
    };

    fs.createReadStream(tarfile)
    .pipe(zlib.createGunzip())
    .pipe(tar.Extract(tar_opt))
    .on('error', cb)
    .on('end', function(err) {
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
    });
}

// fetch tar file for the given name and spec from cache
// callback with local disk location of tar file
var pacman = function(name, spec, cb) {
    var cache_dir = path.join(osenv.home(), '.npminstall');

    // TODO never cache '*' items
    // lookup latest version for * in registry?

    // cache ~##.##.## without the loading ~
    // This allows for exact pinned versions and ~ versions that match
    // to hit the same cache item
    if (spec && /^~\d+[.]\d+[.]\d+$/.test(spec)) {
        spec = spec.replace('~', '');
    }

    if (!fs.existsSync(cache_dir)) {
        fs.mkdirSync(cache_dir);
    }

    var key = crypto.createHash('md5')
        .update(name).update(spec)
        .digest('hex');

    var tarfile = path.join(cache_dir, key + '.tar.gz');

    if (fs.existsSync(tarfile)) {
        return cb(null, tarfile);
    }

    fetch(name, spec, {})
    .syphon(barrage(fs.createWriteStream(tarfile)))
    .wait(function(err) {
        cb(err, tarfile);
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

        // deps we have downloaded cause we need to install them
        var downloaded_deps = [];

        var done = after(deps.length, function(err) {
            if (err) {
                return cb(err);
            }

            // loop deps and install each dep
            inorder(downloaded_deps, function(dep, done) {
                perform_install(dep.name, dep.spec, dep.tarfile, dep.destination, done);
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

            pacman(dep.name, dep.spec, function(err, tarfile) {
                if (err) {
                    return done(err);
                }

                downloaded_deps.push({
                    name: dep.name,
                    spec: dep.spec,
                    destination: final_dest,
                    tarfile: tarfile
                });

                done();
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
