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

import {StatusError} from '../util/statuserror';

/**
 * Extracts a bearer token from an Authorization header value. If the header is
 * not a Bearer token header or is malformed in some way, an exception is
 * thrown.
 */
export function getBearerToken(authHeader?: string): string {
  if (!authHeader) {
    throw new StatusError(
      'No authorization header specified',
      'NO_AUTH_HEADER',
      401
    );
  }
  const authHeaderParts = authHeader.split(' ');
  if (authHeaderParts.length !== 2) {
    throw new StatusError(
      'Badly formed auth header: ' + authHeader,
      'BAD_AUTH_HEADER',
      401
    );
  }
  if (authHeaderParts[0] !== 'Bearer') {
    throw new StatusError(
      'Auth header requires Bearer <token> format',
      'AUTH_HEADER_NO_BEARER_PREFIX',
      401
    );
  }
  const token = authHeaderParts[1].trim();
  if (!token) {
    throw new StatusError(
      'Bearer token is empty',
      'AUTH_HEADER_EMPTY_TOKEN',
      401
    );
  }
  return token;
}
