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

/**
 * A fake example server.
 */
import {log, OprServer, Request, Response, CoreIntegrations} from 'opr-core';
import yargs from 'yargs';
import * as dotenv from 'dotenv';
log.setLevel('WARN');
import {DataSourceOptions, SqlOprPersistentStorage} from 'opr-sql-database';

import {SqlIntegrations} from 'opr-sql-database';
import {LocalIntegrations} from './localintegrations';
import {GcsIntegrations} from 'opr-google-cloud';

// Import any local environment variables from .env
dotenv.config();
const args = yargs
  .usage('Usage: $0 [options]')
  .example('$0', 'Run the server and initialize the database')
  .option('initdb', {
    type: 'string',
    describe:
      'Whether to COMPLETELY ERASE AND RE-CREATE the database on ' +
      'startup. Ignored unless the value is "yes".',
  })
  .option('dbhost', {
    type: 'string',
    describe:
      'Database hostname to use. Defaults to DB_HOST env variable value.',
  })
  .option('dbname', {
    type: 'string',
    describe:
      'Database name to use. Defaults to DB_NAME env variable value,' +
      ' or "postgres" if no env variable is specified.',
  })
  .option('dbuser', {
    type: 'string',
    describe:
      'Database user to use. Defaults to DB_USER env variable value,' +
      ' or "postgres" if no env variable is specified.',
  })
  .option('dbpassword', {
    type: 'string',
    describe:
      'Database password to use. Defaults to DB_PASSWORD env variable value.',
  })
  .option('port', {
    type: 'number',
    describe:
      'Server port. Defaults to PORT env variable or 5000 if no env variable ' +
      'is specified',
  })
  .option('serviceaccount', {
    type: 'string',
    describe:
      'Service account email address to use for this server. Defaults to ' +
      'OPR_SERVICE_ACCOUNT env variable. This is the only account that can ' +
      'make calls to the ingest/ endpoint',
  })
  .option('hostname', {
    type: 'string',
    describe:
      'Hostname to use for this server. Defaults to OPR_HOSTNAME env variable' +
      ' or localhost is no env variable is specified.',
  })
  .option('gcshostfilebucket', {
    type: 'string',
    describe:
      'A GCS bucket name containing a hosts folder with configuration json',
  })
  .option('gcspublickeyspath', {
    type: 'string',
    describe:
      'Path to a GCS folder containing public encryption keys. Defaults to ' +
      'GCS_PUBLIC_KEYS_PATH env variable.',
  })
  .option('gcsprivatekeypath', {
    type: 'string',
    describe:
      'Path to a GCS folder containing the private encryption key. Defaults ' +
      'to GCS_PRIVATE_KEY_PATH env variable.',
  })
  .parseSync();

// We need a main method because we want to use the "await" keyword,
// and it's not allowed in top-level script code. But we can declare an
// async main method and immediately call it.
async function main() {
  console.log('Starting server...', args.initdb);
  // Let's put together all the pieces of a working server.

  let envVarPort = process.env.PORT ? parseInt(process.env.PORT) : undefined;
  if (envVarPort !== undefined && isNaN(envVarPort)) {
    envVarPort = undefined;
  }
  const port = args.port ?? envVarPort ?? 5000;

  const hostname = args.hostname ?? process.env.OPR_HOSTNAME ?? 'localhost';

  const gcsHostFileBucket =
    args.gcshostfilebucket ?? process.env.GCS_HOST_FILE_BUCKET;
  if (!gcsHostFileBucket) {
    throw new Error('No gcs host file bucket defined');
  }

  // Start a local in-memory server to track offers.
  const s = new OprServer(
    {
      storage: {
        moduleName: 'SqlStorage',
        params: getDbOptions(),
      },
      tenantMapping: {
        moduleName: 'TemplateHostIds',
        params: {
          // TODO: Fix this to take a template from an environment variable or
          // command line param
          urlTemplate: hostname + '/orgs/$',
        },
      },
      tenantSetup: {
        // Use the StaticMultitenant driver to read host configurations. This
        // means this server supports multiple hosts, each of which is
        // configured in advance with host configuration read from memory.
        moduleName: 'GcsMultitenant',
        params: {
          bucket: gcsHostFileBucket,
        },
      },
      hostName: hostname,
    },
    {
      ...CoreIntegrations,
      ...SqlIntegrations,
      ...GcsIntegrations,
      ...LocalIntegrations,
    }
  );

  // Most customizations happen per-host, but we can also add global server
  // customizations.
  s.installCustomStartupRoutine(async (express, server) => {
    // Install middleware to require authentication on all global utility
    // handlers. Disable authentication (for testing only!) by commenting out
    // the next line.
    // express.use(
    //   '/util/*',
    //   iamMiddleware({
    //     isAllowed: async (email: string) => {
    //       return email === serviceAccount;
    //     },
    //   })
    // );
    const statusCheckHandler = async (req: Request, res: Response) => {
      res.json('ok');
    };
    express.post('/util/status', statusCheckHandler);
    express.get('/util/status', statusCheckHandler);

    const synchronizeHandler = async (req: Request, res: Response) => {
      await (server.getStorage() as SqlOprPersistentStorage).synchronize(true);
      res.json('ok - db initialized');
    };
    express.post('/util/synchronize', synchronizeHandler);
    express.get('/util/synchronize', synchronizeHandler);

    const ingestAllHandler = async (req: Request, res: Response) => {
      await server.ingest();
      res.json('ok - db initialized');
    };
    express.post('/util/ingest', ingestAllHandler);
    express.get('/util/ingest', ingestAllHandler);
  });
  await s.start(port);
}
void main();

function getDbOptions(): DataSourceOptions {
  const options = {
    type: 'postgres',
    host: args.dbhost ?? process.env.DB_HOST,
    database: args.dbname ?? process.env.DB_NAME ?? 'postgres',
    username: args.dbuser ?? process.env.DB_USER ?? 'postgres',
    password: args.dbpassword ?? process.env.DB_PASSWORD,
    synchronize:
      args.initdb === 'yes' ||
      process.env.DB_SYNCHRONIZE_MAY_CAUSE_DATA_LOSS === 'yes',
    dropSchema:
      args.initdb === 'yes' ||
      process.env.DB_DROPSCHEMA_MAY_CAUSE_DATA_LOSS === 'yes',
  } as DataSourceOptions;
  return options;
}
