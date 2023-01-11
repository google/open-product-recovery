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

import type {Request} from 'express';
import {IntegrationApi} from '../integrations/integrationapi';

export type CustomRequestMethod = 'POST' | 'GET';

/**
 * Interface for custom request handlers for OprServer. This interface requires
 * that the request body is a (possibly empty) JSON object, and that the
 * response is a JSON object. The response object is not directly available. If
 * the handler encounters a problem it must throw a StatusError.
 */
export interface CustomRequestHandler {
  /** The http method for which this handler will be called. */
  readonly method?: Array<CustomRequestMethod> | CustomRequestMethod;

  /** Handles the request and returns a JSON response. */
  handle(
    body: unknown,
    request: Request,
    client: IntegrationApi
  ): Promise<unknown>;
}
