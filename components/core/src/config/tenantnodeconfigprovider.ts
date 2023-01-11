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

import {Pluggable} from '../integrations/pluggable';
import {PluggableFactorySet} from '../integrations/pluggablefactoryset';
import {TenantNodeConfigJson} from './tenantnodeconfig';

/**
 * Provides configuration information for all TenantNodes in a server. Each
 * tenant node must have a unique identifier string that can be extracted from
 * a request URL. TenantNode configuration details are fetched from this unique
 * id string.
 */
export interface TenantNodeConfigProvider<Allowed extends PluggableFactorySet>
  extends Pluggable {
  readonly type: 'tenantConfigProvider';

  getTenantConfig(hostId: string): Promise<TenantNodeConfigJson<Allowed>>;
  getAllTenantIds(): AsyncIterable<string>;
}
