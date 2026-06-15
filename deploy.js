#!/usr/bin/env node

const path = require('path');
const deploy = require('../deploy-plugin.js');

deploy({
  pluginId: 'obsidian-kanban',
  files: [
    { name: 'main.js',       from: path.join(__dirname, 'main.js') },
    { name: 'manifest.json', from: path.join(__dirname, 'manifest.json') },
    { name: 'styles.css',    from: path.join(__dirname, 'styles.css') },
  ],
  mobile: {},
});
