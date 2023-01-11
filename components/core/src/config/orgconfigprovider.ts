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

import {createLocalJWKSet, JSONWebKeySet} from 'jose';
import {OrgConfig} from './orgconfig';
import {OrgConfigCache} from './orgconfigcache';
import {StatusError} from '../util/statuserror';
import {UrlMapper} from '../net/urlmapper';
import {NullUrlMapper} from '../net/nullurlmapper';
import {JsonFetcher} from '../net/jsonfetcher';
import {DefaultJsonFetcher} from '../net/defaultjsonfetcher';
import {OrgConfigCacheNull} from './orgconfigcachenull';

export interface OrgConfigProviderOptions {
  orgConfigCache?: OrgConfigCache;
  urlMapper?: UrlMapper;
  jsonFetcher?: JsonFetcher;
}

export class OrgConfigProvider {
  private orgConfigCache: OrgConfigCache;
  private urlMapper: UrlMapper;
  private jsonFetcher: JsonFetcher;

  /**
   * @param orgConfigCache The org cache to check for standard requests.
   * @param urlMapper A url mapper that remaps urls for fetches. For dev use
   *     only.
   */
  constructor(options: OrgConfigProviderOptions = {}) {
    this.orgConfigCache = options.orgConfigCache || new OrgConfigCacheNull();
    this.urlMapper = options.urlMapper || new NullUrlMapper();
    this.jsonFetcher = options.jsonFetcher || new DefaultJsonFetcher();
  }

  async get(orgUrl: string, noCache = false): Promise<OrgConfig> {
    if (!noCache) {
      const cacheConfig = await this.orgConfigCache.get(orgUrl);
      if (cacheConfig) {
        return cacheConfig;
      }
    }
    // TODO(johndayrichter): Check the returned json with json schema before
    // assuming it's the right type.
    const fetchUrl = this.urlMapper.map(orgUrl);
    const orgConfig = (await this.jsonFetcher.fetch(fetchUrl)) as OrgConfig;
    await this.orgConfigCache.put(orgUrl, orgConfig);
    return orgConfig;
  }

  async getJwks(orgUrl: string, noCache = false): Promise<JSONWebKeySet> {
    if (!noCache) {
      const cacheJwks = await this.orgConfigCache.getJwks(orgUrl);
      if (cacheJwks) {
        return cacheJwks;
      }
    }
    const orgConfig = await this.get(orgUrl, noCache);
    const jwksUrl = orgConfig.jwksURL;
    if (!jwksUrl) {
      throw new StatusError(
        'No JWKS url specified for ' + orgUrl,
        'NO_KEYSET_SPECIFIED',
        500
      );
    }
    const fetchUrl = this.urlMapper.map(jwksUrl);
    const jwks = (await this.jsonFetcher.fetch(fetchUrl)) as JSONWebKeySet;
    // Create, but don't use, a local jwkset to verify that the json is right.
    createLocalJWKSet(jwks);
    await this.orgConfigCache.putJwks(orgUrl, jwks);
    return jwks;
  }
}
