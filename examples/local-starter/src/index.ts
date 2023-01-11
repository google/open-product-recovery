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
 * An example (fake) server.
 *
 * This uses server uses an in-memory database and is designed to create fake
 * offers, on request. It is useful for getting a feel for an OPR server's main
 * components, and can be used as a "partner" node for local development.
 */
import {
  generateKeys,
  CoreIntegrations as CoreIntegrations,
  log,
  OprServer,
  StaticMultitenantOptionsJson,
} from 'opr-core';
import {SqlIntegrations} from 'opr-sql-database';
import {LocalIntegrations} from './localintegrations';
log.setLevel('WARN');

// We need a main method because we want to use the "await" keyword,
// and it's not allowed in top-level script code. But we can declare an
// async main method and immediately call it.

async function main() {
  // Let's put together all the pieces of a working server.

  // Deal with encryption keys. For this toy server, we're generating new keys
  // every time the server starts. In production, they should be loaded from
  // stable storage, like a cloud provider storage system. But this works fine
  // for local testing.
  const pair = await generateKeys('RS256');
  const PRIVATE_KEY = pair.privateKey;
  const PUBLIC_KEY = pair.publicKey;

  // This server will contain two different OPR hosts that share most of the
  // same settings. We'll configure those in one place to avoid reproducing
  // code. Most production servers won't be configured in code like this.
  // Production servers will normally store configuration JSON in some kind of
  // cloud storage system or database.
  const integrations = {
    ...CoreIntegrations,
    ...SqlIntegrations,
    ...LocalIntegrations,
  };
  const baseHostConfig = {
    // Set up a listing policy with a single 'wildcard' entry. This
    // tells the server that it should show offers to everyone.
    listingPolicy: {
      moduleName: 'UniversalListingPolicy',
      params: {
        orgUrls: [
          // Example "real" entry
          // 'https://opr.otherexamplehost.org/org.json',
          '*',
        ],
      },
    },
    // Sets up a key signer with the private key we just generated.
    signer: {
      moduleName: 'LocalKeySigner',
      params: {
        privateKey: PRIVATE_KEY,
      },
    },
    // Sets up a Json Web Key Set with the public key we just generated.
    jwks: {
      moduleName: 'LocalJwks',
      params: {
        publicKeys: [PUBLIC_KEY],
      },
    },
    // Sets up which hosts can access the API on this host.
    accessControlList: {
      moduleName: 'StaticAccessControlList',
      params: {
        // Create an access control list that allows us to control which
        // organizations can talk to this server. For now, we'll add a
        // single 'wildcard' entry with '*', this tells the server that
        // it should show offers to everyone.
        // YOU ALMOST CERTAINLY DON'T WANT A WILDCARD IN A PRODUCTION
        // SERVER!
        allow: [
          // Replace this with a list of servers that can actually talk
          // to your OPR server, like:
          // 'https://example.openproductrecovery.org/org.json',
          '*',
        ],
      },
    },
    // NOTE: You can install offer producers in the config as well, but
    // some offer producers need a handle to the IntegrationApi. That
    // kind of offer producer should be installed through an integration. See
    // integrations.ts for an example of an offer producer installed through an
    // integration.
  };

  // Start a local in-memory server to track offers.

  const s = new OprServer(
    {
      storage: {
        moduleName: 'SqlStorage',
        params: {
          type: 'sqlite',
          database: ':memory',
          synchronize: true,
          dropSchema: true,
        },
      },
      tenantMapping: {
        moduleName: 'TemplateHostIds',
        params: {
          urlTemplate: 'http://localhost:5000/$',
        },
      },
      tenantSetup: {
        // Use the StaticMultitenant driver to read host configurations. This
        // means this server supports multiple hosts, each of which is
        // configured in advance with host configuration read from memory.
        moduleName: 'StaticMultitenant',
        params: {
          hosts: {
            // Sets up a server at http://localhost:5000/main/org.json. This id
            // in this map becomes the first path segment to all requests made
            // to this server.
            main: {
              ...baseHostConfig,
              name: 'MainExampleServer',
              signer: {
                moduleName: 'LocalKeySigner',
                params: {
                  privateKey: PRIVATE_KEY,
                },
              },
              feedConfigs: [
                {
                  organizationUrl: 'http://localhost:5000/other/org.json',
                  maxUpdateFrequencyMillis: 60000,
                },
              ],
              // Install integrations. Integrations are really just installer
              // functions that get passed an instance of IntegrationApi. They
              // can install new endpoints, data providers, and behaviors that
              // occur when the offers on a server change.
              integrations: ['LocalMain', 'helloworld'],
            },
            // Sets up another tenant node at
            // http://localhost:5000/other/org.json
            other: {
              ...baseHostConfig,
              name: 'OtherExampleServer',
              feedConfigs: ['http://localhost:5000/main/org.json'],
              integrations: [
                'LocalMain',
                {
                  moduleName: 'howdyworld',
                  mountPath: '',
                },
              ],
            },
          },
        } as StaticMultitenantOptionsJson<typeof integrations>,
      },
    },
    integrations
  );
  await s.start(5000);
  // The server is up! Things to try:
  // See the MainExampleServer config at http://localhost:5000/main/org.json
  // See the OtherExampleServer config at  http://localhost:5000/other/org.json
  // Read offers into the main server at http://localhost:5000/main/ingest
  // Read offers into the other server at http://localhost:5000/other/ingest
}
void main();
