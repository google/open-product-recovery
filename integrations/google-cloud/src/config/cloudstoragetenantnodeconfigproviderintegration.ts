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

import {PluggableFactorySet, StatusError} from 'opr-core';
import {
  CloudStorageTenantNodeConfigOptionsJson,
  CloudStorageTenantNodeConfigProvider,
} from './cloudstoragetenantnodeconfigprovider';

export const CloudStorageTenantNodeConfigProviderIntegration = {
  async construct<Allowed extends PluggableFactorySet>(
    json: CloudStorageTenantNodeConfigOptionsJson
  ): Promise<CloudStorageTenantNodeConfigProvider<Allowed>> {
    if (!json || !json.bucket) {
      throw new StatusError(
        'CloudStorageHostConfig error: a bucket must be specified',
        'CLOUD_STORAGE_HOST_PROVIDER_NO_BUCKET'
      );
    }
    return new CloudStorageTenantNodeConfigProvider(json);
  },
};
