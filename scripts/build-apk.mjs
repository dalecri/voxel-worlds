// Builds a debug-signed APK (installable by sideloading) and copies it to dist/.
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'android');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT
  || (process.platform === 'win32' ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Android', 'Sdk')
    : process.platform === 'darwin' ? join(homedir(), 'Library', 'Android', 'sdk') : join(homedir(), 'Android', 'Sdk'));
if (!existsSync(sdk)) throw new Error('Android SDK not found; set ANDROID_HOME');
writeFileSync(join(android, 'local.properties'), `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`);

const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
execSync(`"${join(android, gradlew)}" assembleDebug`, { cwd: android, stdio: 'inherit', env: { ...process.env, ANDROID_HOME: sdk } });

mkdirSync(join(root, 'dist'), { recursive: true });
const apk = join(root, 'dist', 'voxel-worlds.apk');
copyFileSync(join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), apk);
console.log('APK ready:', apk);
