# npm-install

recursive installation of npm packages

## use

npm-install can be used as a replacement for `npm install` via the CLI or as a module. It was created to perform installation of modules to make the install tree "correct" during the initial install as well as subsequent package.json dependency updates.

## install

To use via the CLI, install globally with the -g flag. `npm-install` can also be used as a module

### for CLI use

```shell
npm install -g npm-install
```

### for the module api

```shell
npm install npm-install
```

## why

`npm install` is slightly broken when it comes to performing an installation on an already partially installed tree [#3124](https://github.com/isaacs/npm/issues/3124) and the `npm update` command is too aggressive and typically wants to update everything.

This modules does not perform any sort of de-duplication.
