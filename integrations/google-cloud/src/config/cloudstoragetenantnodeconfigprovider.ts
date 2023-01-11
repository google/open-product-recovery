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

import {
  PluggableFactorySet,
  StatusError,
  TenantNodeConfigJson,
  TenantNodeConfigProvider,
} from 'opr-core';
import {getGcsJson, listDir} from '../util/gcs';

export interface CloudStorageTenantNodeConfigOptionsJson {
  bucket: string;
}

export class CloudStorageTenantNodeConfigProvider<
  Allowed extends PluggableFactorySet
> implements TenantNodeConfigProvider<Allowed>
{
  readonly type = 'tenantConfigProvider';

  private bucket: string;

  constructor(options: CloudStorageTenantNodeConfigOptionsJson) {
    this.bucket = options.bucket;
  }

  async getTenantConfig(
    hostId: string
  ): Promise<TenantNodeConfigJson<Allowed>> {
    try {
      return await getGcsJson({
        bucket: this.bucket,
        path: `orgs/${hostId}/config.json`,
      });
    } catch (e) {
      throw new StatusError(
        'No host found with id ' + hostId,
        'NO_HOST_FOUND',
        404,
        e
      );
    }
  }

  async *getAllTenantIds(): AsyncIterable<string> {
    const files = await listDir({bucket: this.bucket, path: 'orgs'});
    for (const file of files) {
      const segments = file.cloudStorageURI.toString().split('/');
      const id = segments[segments.length - 1];
      yield id;
    }
  }
}
