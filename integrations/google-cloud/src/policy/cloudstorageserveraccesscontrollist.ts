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

import type {ServerAccessControlList} from 'opr-core';
import {Storage} from '@google-cloud/storage';
import {GcsFileSpec, getGcsText, toFile} from '../util/gcs';

const REGEXP_PATTERN = /^r\/(.+)\/$/;
export class CloudStorageServerAccessControlList
  implements ServerAccessControlList
{
  readonly type = 'accessControlList';

  private storage: Storage;
  private fileSpec: GcsFileSpec | string;

  constructor(fileSpec: GcsFileSpec | string, storage = new Storage()) {
    this.storage = storage;
    this.fileSpec = fileSpec;
  }

  async isAllowed(organizationURL: string): Promise<boolean> {
    const entries = await this.getAccessControlListEntries();
    for (const entry of entries) {
      if (organizationURL.match(entry)) {
        return true;
      }
    }
    return false;
  }

  private async getAccessControlListEntries(): Promise<Array<string | RegExp>> {
    const gcsAclText = await getGcsText(this.fileSpec, this.storage);
    const aclEntries = gcsAclText.split('\n');
    aclEntries.map(x => {
      const rMatch = REGEXP_PATTERN.exec(x);
      const regexpMatch = rMatch?.groups && rMatch.groups[0];
      return regexpMatch ? new RegExp(regexpMatch) : x;
    });
    return aclEntries;
  }
}
