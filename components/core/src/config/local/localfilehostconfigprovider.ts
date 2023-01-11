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

import {PluggableFactory} from '../../integrations/pluggablefactory';
import {TenantNodeConfigProvider} from '../tenantnodeconfigprovider';
import {StatusError} from '../../util/statuserror';
import {JsonMap} from '../../util/jsonvalue';
import path from 'path';
import fs from 'fs/promises';
import {TenantNodeConfigJson} from '../tenantnodeconfig';
import {PluggableFactorySet} from '../../integrations/pluggablefactoryset';

export interface LocalFileMultitenantOptionsJson extends JsonMap {
  // Path to the base directory of configuration files.
  basePath: string;
}

export const LocalFileMultitenantIntegration = {
  async construct<Allowed extends PluggableFactorySet>(
    json: LocalFileMultitenantOptionsJson
  ): Promise<LocalFileHostConfigProvider<Allowed>> {
    return new LocalFileHostConfigProvider(json);
  },
};

export class LocalFileHostConfigProvider<Allowed extends PluggableFactorySet>
  implements TenantNodeConfigProvider<Allowed>
{
  readonly type = 'tenantConfigProvider';
  private basePath: string;

  constructor(options: LocalFileMultitenantOptionsJson) {
    this.basePath = options.basePath;
  }

  async getTenantConfig(
    hostId: string
  ): Promise<TenantNodeConfigJson<Allowed>> {
    const configFilePath = path.resolve(
      './' + hostId + '/config.json',
      this.basePath
    );
    try {
      return JSON.parse((await fs.readFile(configFilePath)).toString());
    } catch (e) {
      throw new StatusError(
        'No host found for ' + hostId,
        'NO_HOST_FOUND',
        404,
        e
      );
    }
  }

  async *getAllTenantIds(): AsyncIterable<string> {
    const filePaths = await fs.readdir(this.basePath);
    for (const fileName of filePaths) {
      const stat = await fs.stat(path.resolve(fileName, this.basePath));
      if (stat.isDirectory()) {
        yield fileName;
      }
    }
  }
}
