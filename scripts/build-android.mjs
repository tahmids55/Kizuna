/**
 * Build the Kizuna Android app (APK) in one step:
 *   npm run android:apk                          → default server = this computer's LAN address
 *   KIZUNA_SERVER=https://chat.example.com npm run android:apk
 *
 * Requires: JDK 17+ and the Android SDK (ANDROID_HOME, or ~/Android/Sdk).
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const run = (cmd, opts = {}) => {
  console.log(`\n› ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: root, ...opts });
};

const VIRTUAL = /^(docker|br-|veth|virbr|vmnet|vbox|tun|tap|utun|wg|zt|lo)/i;
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
const lan = Object.entries(os.networkInterfaces())
  .filter(([name]) => !VIRTUAL.test(name))
  .flatMap(([, list]) => list ?? [])
  .filter((i) => i.family === 'IPv4' && !i.internal)
  .map((i) => i.address)
  .sort((a, b) => Number(isPrivate(b)) - Number(isPrivate(a)))[0];
const server = process.env.KIZUNA_SERVER || (lan ? `http://${lan}:${process.env.PORT || 4000}` : '');
console.log(`Default server baked into the app: ${server || '(none — users will type it in)'}`);

const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Android', 'Sdk');
if (!fs.existsSync(sdk)) {
  console.error(`\n✗ Android SDK not found at ${sdk}. Install Android Studio (or the command-line tools) and set ANDROID_HOME.`);
  process.exit(1);
}
const localProps = path.join(root, 'android', 'local.properties');
fs.writeFileSync(localProps, `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`);

run('npm run build', { env: { ...process.env, VITE_DEFAULT_SERVER: server } });
run('npx cap sync android');

const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
if (process.platform !== 'win32') fs.chmodSync(path.join(root, 'android', 'gradlew'), 0o755);
run(`${gradlew} assembleDebug --no-daemon -q`, { cwd: path.join(root, 'android'), env: { ...process.env, ANDROID_HOME: sdk } });

const apk = path.join(root, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
const outDir = path.join(root, 'release');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `Kizuna-${pkg.version}.apk`);
fs.copyFileSync(apk, out);
console.log(`\n✓ APK ready: ${path.relative(root, out)} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
console.log('  Install: copy it to your phone and open it, or run  adb install -r ' + path.relative(root, out));
