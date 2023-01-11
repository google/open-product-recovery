/**
 * Copyright 2023 Google LLC
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

import {TenantNodeConfigProvider} from './tenantnodeconfigprovider';
import {StatusError} from '../util/statuserror';
import {iterableToAsync} from '../util/asynciterable';
import {TenantNodeConfigJson} from './tenantnodeconfig';
import {PluggableFactorySet} from '../integrations/pluggablefactoryset';
import {ConfigJson} from './resolveconfigjson';

export interface StaticMultitenantOptions<Allowed extends PluggableFactorySet> {
  hosts: Record<string, TenantNodeConfigJson<Allowed>>;
}

export type StaticMultitenantOptionsJson<Allowed extends PluggableFactorySet> =
  ConfigJson<StaticMultitenantOptions<Allowed>, Allowed>;

export const StaticMultitenantIntegration = {
  async construct<Allowed extends PluggableFactorySet>(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    json: StaticMultitenantOptionsJson<any>
  ): Promise<StaticTenantNodeConfigProvider<Allowed>> {
    return new StaticTenantNodeConfigProvider(json);
  },
};

/**
 * Reads TenantNode configurations from a configuration object passed directly
 * from the configuration json.
 */
export class StaticTenantNodeConfigProvider<Allowed extends PluggableFactorySet>
  implements TenantNodeConfigProvider<Allowed>
{
  readonly type = 'tenantConfigProvider';

  private idMap: Record<string, TenantNodeConfigJson>;

  constructor(options: StaticMultitenantOptionsJson<Allowed>) {
    this.idMap = options.hosts as Record<string, TenantNodeConfigJson>;
  }

  async getTenantConfig(
    hostId: string
  ): Promise<TenantNodeConfigJson<Allowed>> {
    const configJson = this.idMap[hostId];
    if (!configJson) {
      throw new StatusError(
        'No host found for ' + hostId,
        'NO_HOST_FOUND',
        404
      );
    }
    return configJson as TenantNodeConfigJson<Allowed>;
  }

  getAllTenantIds(): AsyncIterable<string> {
    return iterableToAsync(Object.getOwnPropertyNames(this.idMap));
  }
}
