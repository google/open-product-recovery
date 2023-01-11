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

import 'mocha';
import chai, {expect} from 'chai';
import chaiAsPromised from 'chai-as-promised';
import {LocalKeySigner} from '../../../src/auth/local/localkeysigner';

import {OrgConfigProvider} from '../../../src/config/orgconfigprovider';
import {FakeJsonFetcher} from '../../../src/net/fakejsonfetcher';
import FakeOrgAConfigJson from '../../sampledata/orga/org.json';
import FakeOrgAConfigJwks from '../../sampledata/orga/jwks.json';
import FakeOrgAPrivateKey from '../../sampledata/orga/priv.key.json';
import FakeOrgBConfigJson from '../../sampledata/orgb/org.json';
import FakeOrgBConfigJwks from '../../sampledata/orgb/jwks.json';
import FakeOrgBPrivateKey from '../../sampledata/orgb/priv.key.json';
import FakeOrgCConfigJson from '../../sampledata/orgc/org.json';
import FakeOrgCConfigJwks from '../../sampledata/orgc/jwks.json';
import FakeOrgCPrivateKey from '../../sampledata/orgc/priv.key.json';
import FakeOrgDConfigJson from '../../sampledata/orgd/org.json';
import FakeOrgDConfigJwks from '../../sampledata/orgd/jwks.json';
import FakeOrgDPrivateKey from '../../sampledata/orgd/priv.key.json';
import {StandardVerifier} from '../../../src/auth/standardverifier';

chai.use(chaiAsPromised);

describe('LocalKeySigner', () => {
  const fakeJsonFetcher = new FakeJsonFetcher();
  fakeJsonFetcher.map('https://fakeorga.org/org.json', FakeOrgAConfigJson);
  fakeJsonFetcher.map('https://fakeorga.org/jwks.json', FakeOrgAConfigJwks);
  fakeJsonFetcher.map('https://fakeorgb.org/org.json', FakeOrgBConfigJson);
  fakeJsonFetcher.map('https://fakeorgb.org/jwks.json', FakeOrgBConfigJwks);
  fakeJsonFetcher.map('https://fakeorgc.org/org.json', FakeOrgCConfigJson);
  fakeJsonFetcher.map('https://fakeorgc.org/jwks.json', FakeOrgCConfigJwks);
  fakeJsonFetcher.map('https://fakeorgd.org/org.json', FakeOrgDConfigJson);
  fakeJsonFetcher.map('https://fakeorgd.org/jwks.json', FakeOrgDConfigJwks);
  const fakeConfigProvider = new OrgConfigProvider({
    jsonFetcher: fakeJsonFetcher,
  });
  const verifier = new StandardVerifier(fakeConfigProvider);
  describe('signChain', () => {
    const signerA = new LocalKeySigner(
      'https://fakeorga.org/org.json',
      FakeOrgAPrivateKey
    );
    context('with empty chain', async () => {
      const chain = await signerA.signChain(
        [],
        'https://fakeorgb.org/org.json',
        {
          initialEntitlement: 'abc',
          scopes: ['RESHARE'],
        }
      );
      it('should generate a chain with correct length', () => {
        expect(chain.length).to.eq(1);
      });
      it('should reject a new chain with bad issuer', async () => {
        await expect(
          verifier.verifyChain(chain, {
            initialEntitlements: 'abc',
            initialIssuer: 'https://bad.org/org.json',
            finalSubject: 'https://fakeorgb.org/org.json',
          })
        ).to.eventually.be.rejected;
        // await expectRejection(
        //   verifier.verifyChain(chain, {
        //     initialEntitlements: 'abc',
        //     initialIssuer: 'https://bad.org/org.json',
        //     finalSubject: 'https://fakeorgb.org/org.json',
        //   })
        // );
      });
      it('should reject a new chain with bad entitlement', async () => {
        await expect(
          verifier.verifyChain(chain, {
            initialEntitlements: 'bad',
            initialIssuer: 'https://fakeorga.org/org.json',
            finalSubject: 'https://fakeorgb.org/org.json',
          })
        ).to.eventually.be.rejected;
      });
      it('should reject a new chain with bad final subject', async () => {
        await expect(
          verifier.verifyChain(chain, {
            initialEntitlements: 'abc',
            initialIssuer: 'https://fakeorga.org/org.json',
            finalSubject: 'https://bad.org/org.json',
          })
        ).to.eventually.be.rejected;
      });
      it('should reject a new chain with bad final scope', async () => {
        await expect(
          verifier.verifyChain(chain, {
            initialEntitlements: 'abc',
            initialIssuer: 'https://fakeorga.org/org.json',
            finalSubject: 'https://fakeorgb.org/org.json',
            finalScope: 'ACCEPT',
          })
        ).to.eventually.be.rejected;
      });
      it('should accept a new chain with valid expectations', async () => {
        const verified = await verifier.verifyChain(chain, {
          initialEntitlements: 'abc',
          initialIssuer: 'https://fakeorga.org/org.json',
          finalSubject: 'https://fakeorgb.org/org.json',
        });
        expect(verified).to.not.be.null;
      });
    });
    context('with long chain', async () => {
      const signerB = new LocalKeySigner(
        'https://fakeorgb.org/org.json',
        FakeOrgBPrivateKey
      );
      const signerC = new LocalKeySigner(
        'https://fakeorgc.org/org.json',
        FakeOrgCPrivateKey
      );
      const signerD = new LocalKeySigner(
        'https://fakeorgd.org/org.json',
        FakeOrgDPrivateKey
      );
      let chain = await signerA.signChain([], 'https://fakeorgb.org/org.json', {
        initialEntitlement: 'xyz',
        scopes: ['RESHARE', 'ACCEPT'],
      });
      chain = await signerB.signChain(chain, 'https://fakeorgc.org/org.json', {
        scopes: ['RESHARE', 'ACCEPT'],
      });
      chain = await signerC.signChain(chain, 'https://fakeorgd.org/org.json', {
        scopes: ['RESHARE', 'ACCEPT'],
      });
      chain = await signerD.signChain(chain, 'https://fakeorge.org/org.json', {
        scopes: ['ACCEPT'],
      });
      it('should generate a chain with correct length', () => {
        expect(chain.length).to.eq(4);
      });
      it('should reject long chain with bad initial entitlement', async () => {
        await expect(
          verifier.verifyChain(chain, {
            initialEntitlements: 'bad',
            initialIssuer: 'https://fakeorga.org/org.json',
            finalSubject: 'https://fakeorge.org/org.json',
          })
        ).to.eventually.be.rejected;
      });
      it('should reject a long chain with bad final scope', async () => {
        await expect(
          verifier.verifyChain(chain, {
            initialEntitlements: 'xyz',
            initialIssuer: 'https://fakeorga.org/org.json',
            finalSubject: 'https://fakeorge.org/org.json',
            finalScope: 'RESHARE',
          })
        ).to.eventually.be.rejected;
      });
      it('should reject a rearranged long chain', async () => {
        const rearranged = [...chain];
        rearranged[1] = chain[2];
        rearranged[2] = chain[1];
        await expect(
          verifier.verifyChain(rearranged, {
            initialEntitlements: 'xyz',
            initialIssuer: 'https://fakeorga.org/org.json',
            finalSubject: 'https://fakeorge.org/org.json',
            finalScope: 'ACCEPT',
          })
        ).to.eventually.be.rejected;
      });
      it('should accept a long chain with valid expectations', async () => {
        const verified = await verifier.verifyChain(chain, {
          initialEntitlements: 'xyz',
          initialIssuer: 'https://fakeorga.org/org.json',
          finalSubject: 'https://fakeorge.org/org.json',
          finalScope: 'ACCEPT',
        });
        expect(verified).to.not.be.null;
      });
    });
  });
});
