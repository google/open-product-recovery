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

import {PluggableFactory} from '../integrations/pluggablefactory';
import {ServerAccessControlList} from './serveraccesscontrollist';

export class StaticServerAccessControlList implements ServerAccessControlList {
  readonly type = 'accessControlList';

  private accessControlList: Record<string, boolean>;

  constructor(accessControlList: Array<string>) {
    this.accessControlList = {};
    for (const entry of accessControlList) {
      this.accessControlList[entry] = true;
    }
  }

  async isAllowed(organizationURL: string): Promise<boolean> {
    return (
      this.accessControlList[organizationURL] === true ||
      this.accessControlList['*'] === true
    );
  }
}

export interface IntegrationOptions {
  allow: Array<string>;
}

export const StaticServerAccessControlListIntegration = {
  async construct(json) {
    return new StaticServerAccessControlList(json.allow);
  },
} as PluggableFactory<StaticServerAccessControlList, IntegrationOptions>;
