'use strict';
// Prefer a persistent user-level browser/runtime cache when this host has one.
// Fall back to the temporary workspace used by earlier P3 browser runs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const home = os.homedir();
const persistentBrowsers = path.join(home, '.cache', 'ms-playwright');
const persistentRuntime = path.join(home, '.cache', 'splendor-p3-runtime');
const persistentLibs = path.join(persistentRuntime, 'usr', 'lib', 'x86_64-linux-gnu');
const persistentFonts = path.join(persistentRuntime, 'fontconfig.conf');
const hasPersistentWebKit = fs.existsSync(persistentBrowsers)
  && fs.readdirSync(persistentBrowsers).some(name => /^webkit-\d+$/.test(name));

if (hasPersistentWebKit && fs.existsSync(path.join(persistentLibs, 'libxslt.so.1'))) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= persistentBrowsers;
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ||= '1';
  process.env.LD_LIBRARY_PATH = `${persistentLibs}:${process.env.LD_LIBRARY_PATH || ''}`;
  if (fs.existsSync(persistentFonts)) process.env.FONTCONFIG_FILE ||= persistentFonts;
} else if (fs.existsSync('/tmp/splendor-p3-browsers/webkit-2370/pw_run.sh')
  && fs.existsSync('/tmp/splendor-p3-runtime/usr/lib/x86_64-linux-gnu/libavif.so.16')) {
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= '/tmp/splendor-p3-browsers';
  process.env.PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS ||= '1';
  process.env.LD_LIBRARY_PATH = `/tmp/splendor-p3-runtime/usr/lib/x86_64-linux-gnu:${process.env.LD_LIBRARY_PATH || ''}`;
  if (fs.existsSync('/tmp/splendor-p3-fontconfig.conf')) process.env.FONTCONFIG_FILE ||= '/tmp/splendor-p3-fontconfig.conf';
}
