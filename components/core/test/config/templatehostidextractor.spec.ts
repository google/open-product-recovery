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
import {TemplateHostIdExtractor} from '../../src/config/templatehostidextractor';

describe('TemplateHostIdExtractor', () => {
  describe('getHostId', () => {
    it('subdomain', () => {
      const hostIdExtractor = new TemplateHostIdExtractor({
        urlTemplate: 'https://$.example.org',
      });
      let hostId = hostIdExtractor.getTenantId(
        'https://mst3k.example.org/org.json'
      );
      expect(hostId).to.equal('mst3k');
      hostId = hostIdExtractor.getTenantId(
        'https://opr_host-with_chars.example.org/org.json'
      );
      expect(hostId).to.equal('opr_host-with_chars');
      expect(() => {
        hostIdExtractor.getTenantId('https://example.org/index.html');
      }).to.throw;
    });
    it('path', () => {
      const hostIdExtractor = new TemplateHostIdExtractor({
        urlTemplate: 'https://opr.openproductrecovery.org/hosts/$',
      });
      const hostId = hostIdExtractor.getTenantId(
        'https://opr.openproductrecovery.org/hosts/mst3k/api/list'
      );
      expect(hostId).to.equal('mst3k');
    });
  });
  describe('getRootPathFromId', () => {
    it('subdomain', () => {
      const hostIdExtractor = new TemplateHostIdExtractor({
        urlTemplate: 'https://$.example.org',
      });
      const rootPath = hostIdExtractor.getRootPathFromId('mst3k');
      expect(rootPath).to.equal('https://mst3k.example.org');
    });
    it('path', () => {
      const hostIdExtractor = new TemplateHostIdExtractor({
        urlTemplate: 'https://opr.openproductrecovery.org/hosts/$',
      });
      const rootPath = hostIdExtractor.getRootPathFromId('mst3k');
      expect(rootPath).to.equal(
        'https://opr.openproductrecovery.org/hosts/mst3k'
      );
    });
  });
});
