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

import {PluggableFactory} from 'opr-core';
import {DataSourceOptions} from 'typeorm';
import {SqlOprPersistentStorage} from './sqloprpersistentstorage';

export const SqlOprPersistentStorageIntegration = {
  async construct(json: DataSourceOptions): Promise<SqlOprPersistentStorage> {
    const storage = new SqlOprPersistentStorage({
      dsOptions: json,
    });
    await storage.initialize();
    return storage;
  },
  async destroy(obj: SqlOprPersistentStorage): Promise<void> {
    await obj.shutdown();
  },
} as PluggableFactory<SqlOprPersistentStorage, DataSourceOptions>;
