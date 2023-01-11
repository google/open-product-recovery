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
import {expect} from 'chai';
import {examples, Offer} from 'opr-models';
import {OfferMapLookup} from '../../src/model/offerlookup';
import {applyOfferPatch} from '../../src/diff/patch';
import {
  asUnversionedStructuredId,
  asVersionedStructuredId,
} from '../../src/model/offerid';
import {deepClone} from 'fast-json-patch';

describe('patch tests', () => {
  describe('applyOfferPatch', () => {
    it('should handle root add', async () => {
      const offerLookup = new OfferMapLookup();
      const offer = examples.SimpleOffer as Offer;
      const result = await applyOfferPatch(offerLookup, {
        target: asUnversionedStructuredId(offer),
        patch: [
          {
            op: 'add',
            path: '',
            value: offer as unknown as Record<string, unknown>,
          },
        ],
      });
      expect(result.type).to.equal('INSERT');
      expect(result.oldOffer).to.be.undefined;
      expect(result.newOffer).to.deep.equal(offer);
    });
    it('should handle root add with prior value', async () => {
      const oldOffer = deepClone(examples.SimpleOffer) as Offer;
      const newOffer = deepClone(examples.SimpleOffer) as Offer;
      const offerLookup = new OfferMapLookup(oldOffer);
      newOffer.description = 'New description';
      newOffer.offerUpdateUTC = 100;
      const result = await applyOfferPatch(offerLookup, {
        target: asUnversionedStructuredId(oldOffer),
        patch: [
          {
            op: 'add',
            path: '',
            value: newOffer as unknown as Record<string, unknown>,
          },
        ],
      });
      expect(result.type).to.equal('UPDATE');
      expect(result.oldOffer).to.deep.equal(oldOffer);
      expect(result.newOffer).to.deep.equal(newOffer);
    });
    it('should handle root replace with prior value', async () => {
      const oldOffer = deepClone(examples.SimpleOffer) as Offer;
      const newOffer = deepClone(examples.SimpleOffer) as Offer;
      const offerLookup = new OfferMapLookup(oldOffer);
      newOffer.description = 'New description';
      newOffer.offerUpdateUTC = 100;
      const result = await applyOfferPatch(offerLookup, {
        target: asUnversionedStructuredId(oldOffer),
        patch: [
          {
            op: 'replace',
            path: '',
            value: newOffer as unknown as Record<string, unknown>,
          },
        ],
      });
      expect(result.type).to.equal('UPDATE');
      expect(result.oldOffer).to.deep.equal(oldOffer);
      expect(result.newOffer).to.deep.equal(newOffer);
    });
    it('should handle root replace with no prior value', async () => {
      const offerLookup = new OfferMapLookup();
      const offer = examples.SimpleOffer as Offer;
      const result = await applyOfferPatch(offerLookup, {
        target: asUnversionedStructuredId(offer),
        patch: [
          {
            op: 'replace',
            path: '',
            value: offer as unknown as Record<string, unknown>,
          },
        ],
      });
      expect(result.type).to.equal('INSERT');
      expect(result.oldOffer).to.be.undefined;
      expect(result.newOffer).to.deep.equal(offer);
    });
    it('should handle root delete', async () => {
      const offer = examples.SimpleOffer as Offer;
      const offerLookup = new OfferMapLookup(offer);
      const result = await applyOfferPatch(offerLookup, {
        target: asUnversionedStructuredId(offer),
        patch: [
          {
            op: 'remove',
            path: '',
          },
        ],
      });
      expect(result.type).to.equal('DELETE');
      expect(result.oldOffer).to.deep.equal(offer);
      expect(result.newOffer).to.be.undefined;
    });
    it('should handle deep patch on unversioned id', async () => {
      const offer = examples.SimpleOffer as Offer;
      const offerLookup = new OfferMapLookup(offer);
      const result = await applyOfferPatch(offerLookup, {
        target: asUnversionedStructuredId(offer),
        patch: [
          {
            op: 'replace',
            path: '/description',
            value: 'New desc',
          },
          {
            op: 'replace',
            path: '/offerUpdateUTC',
            value: 100,
          },
        ],
      });
      expect(result.type).to.equal('UPDATE');
      expect(result.oldOffer).to.deep.equal(offer);
      expect(result.newOffer?.description).to.equal('New desc');
      expect(result.newOffer?.offerUpdateUTC).to.equal(100);
    });
    it('should handle deep patch on versioned id', async () => {
      const offer = examples.SimpleOffer as Offer;
      const offerLookup = new OfferMapLookup(offer);
      const result = await applyOfferPatch(offerLookup, {
        target: asVersionedStructuredId(offer),
        patch: [
          {
            op: 'replace',
            path: '/description',
            value: 'New desc',
          },
          {
            op: 'replace',
            path: '/offerUpdateUTC',
            value: 100,
          },
        ],
      });
      expect(result.type).to.equal('UPDATE');
      expect(result.oldOffer).to.deep.equal(offer);
      expect(result.newOffer?.description).to.equal('New desc');
      expect(result.newOffer?.offerUpdateUTC).to.equal(100);
    });
    it('should error on ops against missing offer version', async () => {
      const offer = deepClone(examples.SimpleOffer) as Offer;
      const offerLookup = new OfferMapLookup(offer);
      const result = await applyOfferPatch(offerLookup, {
        target: {
          postingOrgUrl: 'https://citadelofdanas.org/org.json',
          id: 'abc',
          lastUpdateTimeUTC: 666,
        },
        patch: [
          {
            op: 'replace',
            path: '/description',
            value: 'New desc',
          },
          {
            op: 'replace',
            path: '/offerUpdateUTC',
            value: 100,
          },
        ],
      });
      expect(result.type).to.equal('ERROR');
      expect(result.oldOffer).to.be.undefined;
      expect(result.newOffer).to.be.undefined;
      expect(offer).to.deep.equal(examples.SimpleOffer);
    });
    it('should handle delete of missing item', async () => {
      const offer = examples.SimpleOffer as Offer;
      const offerLookup = new OfferMapLookup();
      const result = await applyOfferPatch(offerLookup, {
        target: asUnversionedStructuredId(offer),
        patch: [
          {
            op: 'remove',
            path: '',
          },
        ],
      });
      expect(result.type).to.equal('NOOP');
      expect(result.oldOffer).to.be.undefined;
      expect(result.newOffer).to.be.undefined;
    });
    it('should return error on deep patch of empty object', async () => {
      const offer = examples.SimpleOffer as Offer;
      // NOTE: Empty map lookup means that we're targeting a missing offer
      const offerLookup = new OfferMapLookup();
      const result = await applyOfferPatch(offerLookup, {
        target: asUnversionedStructuredId(offer),
        patch: [
          {
            op: 'replace',
            path: '/description',
            value: 'New desc',
          },
          {
            op: 'replace',
            path: '/offerUpdateUTC',
            value: 100,
          },
        ],
      });
      expect(result.type).to.equal('ERROR');
      expect(result.oldOffer).to.be.undefined;
      expect(result.newOffer).to.be.undefined;
    });
    it('should handle clear', async () => {
      const offer = examples.SimpleOffer as Offer;
      const offerLookup = new OfferMapLookup(offer);
      const result = await applyOfferPatch(offerLookup, 'clear');
      expect(result.type).to.equal('CLEAR');
      expect(result.oldOffer).to.be.undefined;
      expect(result.newOffer).to.be.undefined;
    });
  });
});
