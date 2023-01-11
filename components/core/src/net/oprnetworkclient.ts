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

import {Signer, IssueTokenOptions} from '../auth/signer';
import {OrgConfig} from '../config/orgconfig';
import {OrgConfigProvider} from '../config/orgconfigprovider';
import {NullUrlMapper} from './nullurlmapper';
import {StatusError} from '../util/statuserror';
import {UrlMapper} from './urlmapper';
import {DefaultJsonFetcher} from './defaultjsonfetcher';
import {JsonFetcher} from './jsonfetcher';
import {getRequiredScopes} from '../auth/getrequiredscopes';
import {ListOffersPayload, ListOffersResponse} from 'opr-models';

export type Command = 'ACCEPT' | 'LIST' | 'HISTORY' | 'REJECT' | 'RESERVE';

/**
 * The client used to make requests to OPR servers. This class is responsible
 * for:
 * 1) Looking up an organization's config file
 * 2) Routing a request to the right URL, based on the URL mappings in the
 *    organization's configuration file
 * 3) Attaching credentials to the request
 * 4) Issuing the request.
 *
 * All requests between OPR servers should be done via an OprClient class.
 */
export class OprNetworkClient {
  private signer: Signer;
  private configProvider: OrgConfigProvider;
  private urlMapper: UrlMapper;
  private jsonFetcher: JsonFetcher;

  constructor(config: OprClientConfig) {
    this.signer = config.signer;
    this.configProvider = config.configProvider;
    this.urlMapper = config.urlMapper || new NullUrlMapper();
    this.jsonFetcher = config.jsonFetcher || new DefaultJsonFetcher();
  }

  static getFetchUrl(
    orgConfig: OrgConfig,
    command: Command
  ): string | undefined {
    switch (command) {
      case 'LIST':
        return orgConfig.listProductsEndpointURL;
      case 'ACCEPT':
        return orgConfig.acceptProductsEndpointURL;
      case 'REJECT':
        return orgConfig.rejectProductsEndpointURL;
      case 'RESERVE':
        return orgConfig.reserveProductsEndpointURL;
      case 'HISTORY':
        return orgConfig.acceptHistoryEndpointURL;
      default:
        throw new Error('Unknown command:' + command);
    }
  }

  async exec(
    command: Command,
    target: string,
    payload?: unknown,
    userSignerOptions?: IssueTokenOptions
  ) {
    console.log('Running exec', target);
    const orgConfig = await this.configProvider.get(target);
    console.log('Fetched org config', orgConfig);
    const signerOptions = {
      ...userSignerOptions,
      scopes: getRequiredScopes(command),
    } as IssueTokenOptions;
    const token = await this.signer.issueToken(target, signerOptions);
    const url = OprNetworkClient.getFetchUrl(orgConfig, command);
    console.log('Got fetch url', url);
    if (!url) {
      throw new StatusError(
        'Organization ' + target + 'does not support ' + command,
        'ORG_DOES_NOT_SUPPORT_OPERATION',
        501
      );
    }
    const fetchUrl = this.urlMapper.map(url);
    return await this.jsonFetcher.fetch(fetchUrl, {
      method: 'POST',
      body: JSON.stringify(payload),
      headers: {
        Authorization: 'Bearer ' + token,
      },
    });
  }

  async list(
    target: string,
    payload?: ListOffersPayload,
    userSignerOptions?: IssueTokenOptions
  ): Promise<ListOffersResponse> {
    return (await this.exec(
      'LIST',
      target,
      payload || {},
      userSignerOptions
    )) as ListOffersResponse;
  }
}

export interface OprClientConfig {
  /** A signer used to generate auth tokens for requests to other servers. */
  signer: Signer;
  /**
   * An org config provider for doing org configuration lookups. When an
   * OprClient is constructed by the OprServer, it will use its own
   * OrgConfigProvider for this value if it is not specified.
   */
  configProvider: OrgConfigProvider;
  /** A url mapper used during debugging and testing. */
  urlMapper?: UrlMapper;
  /**
   * The JsonFetcher to use when making requests. If specified, the url
   * mapper is ignored.
   */
  jsonFetcher?: JsonFetcher;
}
