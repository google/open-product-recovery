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

/**
 * Extracts a TenantNode unique identifier from a URL.
 */
export interface TenantIdExtractor extends Pluggable {
  readonly type: 'tenantIdExtractor';

  /** Extracts the TenantNode id from a request url. */
  getTenantId(reqUrl: string): string | undefined;

  /**
   * Generates the root path on the server for the given TenantNode id. This
   * is the base path from which all other paths are generated for this
   * TenantNode.
   */
  getRootPathFromId(id: string): string;
}
