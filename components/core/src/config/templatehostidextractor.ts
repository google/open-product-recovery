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
import {JsonMap} from '../util/jsonvalue';
import {TenantIdExtractor} from './tenantidextractor';

export interface TemplateHostIdExtractorOptionsJson extends JsonMap {
  urlTemplate: string;
}

export class TemplateHostIdExtractor implements TenantIdExtractor {
  readonly type = 'tenantIdExtractor';

  private urlTemplate: string;
  private idExtractRegexp: RegExp;

  constructor(options: TemplateHostIdExtractorOptionsJson) {
    this.urlTemplate = options.urlTemplate;
    this.idExtractRegexp = new RegExp(
      this.urlTemplate.replace('$', '([a-z0-9_-]+)')
    );
  }

  getTenantId(reqUrl: string): string | undefined {
    const result = this.idExtractRegexp.exec(reqUrl);
    if (result && result.length > 0 && result[1]) {
      return result[1];
    }
    return undefined;
  }

  getRootPathFromId(id: string): string {
    return this.urlTemplate.replace('$', id);
  }
}

export const TemplateHostIdExtractorIntegration = {
  async construct(json, context?) {
    return new TemplateHostIdExtractor(
      json as TemplateHostIdExtractorOptionsJson
    );
  },
} as PluggableFactory<
  TemplateHostIdExtractor,
  TemplateHostIdExtractorOptionsJson
>;
