/**
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {generateKeys, ALGORITHM_NAMES, CURVE_NAMES} from '../auth/generatekeys';
import {promises as fs} from 'fs';
import {GenerateKeyPairOptions} from 'jose';
import yargs from 'yargs';

const argv = yargs(process.argv.slice(2))
  .usage('Usage: $0 [options]')
  .option('publicfile', {
    type: 'string',
    desc: 'File path for the public key output',
  })
  .option('privatefile', {
    type: 'string',
    desc: 'File path for the private key output',
  })
  .option('alg', {
    type: 'string',
    desc: 'The key algorithm, defaults to RS256',
    choices: ALGORITHM_NAMES,
    default: 'RS256',
    alias: 'a',
  })
  .option('crv', {
    type: 'string',
    desc:
      'Elliptic curve names for EC algorithms. ' +
      'This is only required for some EC algorithms',
    choices: CURVE_NAMES,
    alias: 'c',
  })
  .option('modulus', {
    type: 'number',
    desc: 'Optional modulus length to use for RSA algorithms.',
    alias: 'm',
  })
  .option('silent', {
    type: 'boolean',
    desc: 'If true, suppress console output',
    alias: 's',
  })
  .help('h')
  .alias('h', 'help')
  .parseSync();

async function main() {
  const options = {
    modulusLength: argv.modulus,
    crv: argv.crv,
  } as GenerateKeyPairOptions;
  const keys = await generateKeys(argv.alg, options);
  if (!argv.silent) {
    console.log(JSON.stringify(keys, null, 2));
  }
  if (argv.publicfile) {
    await fs.writeFile(
      argv.publicfile,
      JSON.stringify(keys.publicKey, null, 2)
    );
  }
  if (argv.privatefile) {
    await fs.writeFile(
      argv.privatefile,
      JSON.stringify(keys.privateKey, null, 2)
    );
  }
}
void main();
