import * as Bundler from 'parcel-bundler';
import extendBundlerWithAtAlias = require('parcel-plugin-at-alias');
import extendBundlerWithCodegen = require('parcel-plugin-codegen');
import extendBundlerWithImportMaps = require('parcel-plugin-import-maps');
import { PiletSchemaVersion } from 'piral-cli';
import { extendBundlerWithExternals, combineExternals } from 'parcel-plugin-externals/utils';
import { existsSync, statSync, readFile, writeFile } from 'fs';
import { resolve, dirname, basename } from 'path';
import { patchModule } from './bundler-patches';
import { extendConfig } from './settings';
import { BundlerSetup } from '../types';
import {
  log,
  computeHash,
  checkExists,
  checkIsDirectory,
  readJson,
  readText,
  createFileIfNotExists,
  writeText,
  writeJson,
  getFileNames,
  ForceOverwrite,
} from 'piral-cli/utils';

let original: any;

export function setupBundler(setup: BundlerSetup) {
  const proto = Bundler.prototype as any;
  let bundler: Bundler;

  if (!original) {
    original = proto.getLoadedAsset;
  } else {
    proto.getLoadedAsset = original;
  }

  if (setup.type === 'pilet') {
    const { entryModule, targetDir, externals, config } = setup;
    bundler = new Bundler(entryModule, extendConfig(config));
    const resolver = combineExternals(targetDir, [], externals);
    extendBundlerWithExternals(bundler, resolver);
  } else {
    const { entryFiles, config } = setup;
    bundler = new Bundler(entryFiles, extendConfig(config));
  }

  extendBundlerWithAtAlias(bundler);
  extendBundlerWithCodegen(bundler);
  extendBundlerWithImportMaps(bundler);
  return bundler;
}

export interface BundleSource {
  children: Set<Bundler.ParcelBundle>;
  src: string;
  map: string;
}

export function gatherJsBundles(bundle: Bundler.ParcelBundle, gatheredBundles: Array<BundleSource> = []) {
  if (bundle.type === 'js') {
    let map = undefined;

    for (const childBundle of bundle.childBundles) {
      if (childBundle.name.endsWith('.js.map')) {
        map = childBundle.name;
        break;
      }
    }

    gatheredBundles.push({
      children: bundle.childBundles,
      src: bundle.name,
      map,
    });
  }

  for (const childBundle of bundle.childBundles) {
    gatherJsBundles(childBundle, gatheredBundles);
  }

  return gatheredBundles;
}

// See https://github.com/smapiot/piral/issues/121#issuecomment-572055594
const defaultIgnoredPackages = ['core-js'];

/**
 * The motivation for this method came from:
 * https://github.com/parcel-bundler/parcel/issues/1655#issuecomment-568175592
 * General idea:
 * Treat all modules as non-optimized for the current output target.
 * This makes sense in general as only the application should determine the target.
 */
async function patch(staticPath: string, ignoredPackages: Array<string>) {
  log('generalDebug_0003', `Patching files in "${staticPath}" ...`);
  const folderNames = await getFileNames(staticPath);
  return Promise.all(
    folderNames.map(async folderName => {
      if (!ignoredPackages.includes(folderName)) {
        const rootName = resolve(staticPath, folderName);
        const isDirectory = await checkIsDirectory(rootName);

        if (isDirectory) {
          if (folderName.startsWith('@')) {
            // if we are scoped, just go down
            await patch(rootName, ignoredPackages);
          } else {
            try {
              const packageFileData = await readJson(rootName, 'package.json');

              if (packageFileData.name && packageFileData._piralOptimized === undefined) {
                packageFileData._piralOptimized = packageFileData.browserslist || true;
                delete packageFileData.browserslist;

                await writeJson(rootName, 'package.json', packageFileData, true);
                await writeText(rootName, '.browserslistrc', 'node 10.11');
                await patchModule(folderName, rootName);
              }

              await patchFolder(rootName, ignoredPackages);
            } catch (e) {
              log('generalDebug_0003', `Encountered a patching error: ${e}`);
            }
          }
        }
      }
    }),
  );
}

async function patchFolder(rootDir: string, ignoredPackages: Array<string>) {
  const file = '.patched';
  const modulesDir = resolve(rootDir, 'node_modules');
  const exists = await checkExists(modulesDir);

  if (exists) {
    const lockContent = (await readText(rootDir, 'package-lock.json')) || (await readText(rootDir, 'yarn.lock'));
    const currHash = computeHash(lockContent);
    const prevHash = await readText(modulesDir, file);
    log('generalDebug_0003', `Evaluated patch module hashes: "${currHash}" and "${prevHash}".`);

    if (prevHash !== currHash) {
      await patch(modulesDir, ignoredPackages);
      await createFileIfNotExists(modulesDir, file, currHash, ForceOverwrite.yes);
    }
  }
}

export async function patchModules(rootDir: string, ignoredPackages = defaultIgnoredPackages) {
  log('generalDebug_0003', `Patching modules starting in "${rootDir}" ...`);
  const otherRoot = resolve(require.resolve('parcel-bundler'), '..', '..', '..');
  await patchFolder(rootDir, ignoredPackages);

  if (otherRoot !== rootDir) {
    log('generalDebug_0003', `Also patching modules in "${otherRoot}" ...`);
    await patchFolder(otherRoot, ignoredPackages);
  }
}

const bundleUrlRef = '__bundleUrl__';
const piletMarker = '//@pilet v:';
const preamble = `!(function(global,parcelRequire){'use strict';`;
const insertScript = `function define(getExports){(typeof document!=='undefined')&&(document.currentScript.app=getExports())};define.amd=true;`;
const getBundleUrl = `function(){try{throw new Error}catch(t){const e=(""+t.stack).match(/(https?|file|ftp|chrome-extension|moz-extension):\\/\\/[^)\\n]+/g);if(e)return e[0].replace(/^((?:https?|file|ftp|chrome-extension|moz-extension):\\/\\/.+)\\/[^\\/]+$/,"$1")+"/"}return"/"}`;

function isFile(bundleDir: string, name: string) {
  const path = resolve(bundleDir, name);
  return existsSync(path) && statSync(path).isFile();
}

function getScriptHead(version: PiletSchemaVersion, prName: string) {
  const bundleUrl = `var ${bundleUrlRef}=${getBundleUrl}();`;

  switch (version) {
    case 'v0': // directEval
      return `${piletMarker}0\n${preamble}${bundleUrl}`;
    case 'v1': // currentScript
      return `${piletMarker}1(${prName})\n${preamble}${bundleUrl}${insertScript}`;
    default:
      log('invalidSchemaVersion_0071', version, ['v0', 'v1']);
      return getScriptHead('v0', prName);
  }
}

/**
 * Transforms a pilet's bundle to a microfrontend entry module.
 * @param bundle The bundle to transform.
 * @param version The manifest version to create.
 */
export async function postProcess(bundle: Bundler.ParcelBundle, version: PiletSchemaVersion) {
  const hash = bundle.getHash();
  const prName = `pr_${hash}`;
  const head = getScriptHead(version, prName);
  const bundles = gatherJsBundles(bundle);

  await Promise.all(
    bundles.map(
      ({ src, children }) =>
        new Promise<void>((resolve, reject) => {
          const bundleDir = dirname(src);

          readFile(src, 'utf8', (err, data) => {
            if (err) {
              return reject(err);
            }

            let result = data.replace(/^module\.exports="(.*)";$/gm, (str, value) => {
              if (isFile(bundleDir, value)) {
                return str.replace(`"${value}"`, `${bundleUrlRef}+"${value}"`);
              }

              return str;
            });

            /**
             * In pure JS bundles (i.e., we are not starting with an HTML file) Parcel
             * just omits the included CSS... This is bad (to say the least).
             * Here, we search for any sibling CSS bundles (there should be at most 1)
             * and include it asap using a standard approach.
             * Note: In the future we may allow users to disable this behavior (via a Piral
             * setting to disallow CSS inject).
             */
            const [cssBundle] = [...children].filter(m => /\.css$/.test(m.name));

            if (cssBundle) {
              const cssName = basename(cssBundle.name);
              const stylesheet = [
                `var d=document`,
                `var e=d.createElement("link")`,
                `e.type="text/css"`,
                `e.rel="stylesheet"`,
                `e.href=${bundleUrlRef}+${JSON.stringify(cssName)}`,
                `d.head.appendChild(e)`,
              ].join(';');

              /**
               * Only happens in debug mode:
               * Apply this only when the stylesheet is not yet part of the file.
               * This solves the edge case of touching files (i.e., saving without any change).
               * Here, Parcel triggers a re-build, but does not change the output files.
               * Making the change here would destroy the file.
               */
              if (result.indexOf(stylesheet) === -1) {
                result = `(function(){${stylesheet}})();${result}`;
              }
            }

            // Only happens in (pilet) debug mode:
            // Untouched bundles are not rewritten so we should not just wrap them
            // again. We replace the existing Piral Require reference with a new one.
            if (result.startsWith(piletMarker)) {
              result = result.replace(/\.pr_[A-Fa-f0-9]{32}/g, `.${prName}`);
            } else {
              /**
               * Wrap the JavaScript output bundle in an IIFE, fixing `global` and
               * `parcelRequire` declaration problems, and preventing `parcelRequire`
               * from leaking into global (window).
               * @see https://github.com/parcel-bundler/parcel/issues/1401
               */
              result = [
                head,
                result
                  .split('"function"==typeof parcelRequire&&parcelRequire')
                  .join(`"function"==typeof global.${prName}&&global.${prName}`),
                `;global.${prName}=parcelRequire}(window, window.${prName}));`,
              ].join('\n');
            }

            writeFile(src, result, 'utf8', err => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          });
        }),
    ),
  );

  return prName;
}
